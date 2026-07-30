import bcrypt from "bcryptjs";
import AppError from "../errors/AppError.js";
import { User } from "../models/user.model.js";
import { Student } from "../models/student.model.js";
import { createToken, verifyToken } from "../utils/authToken.js";
import { generateOTP, sendOTP } from "../utils/commonMethod.js";
import { DEFAULT_SECURITY_QUESTIONS } from "../utils/securityQuestions.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";

const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_ACCESS_EXPIRY || "15m";
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || process.env.JWT_REFRESH_EXPIRY || "7d";

const normalizeQuestionKey = (value) => String(value || "").trim().toLowerCase();

const DEFAULT_SECURITY_QUESTION_KEY_MAP = new Map(
  DEFAULT_SECURITY_QUESTIONS.map((question) => [normalizeQuestionKey(question), question]),
);

const buildAnswerMap = (answers) => {
  const map = new Map();

  for (const item of answers || []) {
    const questionKey = normalizeQuestionKey(item?.question);
    const normalizedAnswer = String(item?.answer || "").trim().toLowerCase();

    if (!questionKey || !normalizedAnswer) continue;
    map.set(questionKey, normalizedAnswer);
  }

  return map;
};

const getUniqueSecurityQuestions = (questions = []) => {
  const byKey = new Map();

  for (const item of questions) {
    const questionKey = normalizeQuestionKey(item?.question);
    if (!questionKey || !item?.answerHash || byKey.has(questionKey)) continue;

    byKey.set(questionKey, {
      question: String(item.question).trim(),
      answerHash: item.answerHash,
    });
  }

  return [...byKey.values()];
};

const parseSecurityQuestionsForSave = async (body = {}) => {
  let entries = [];

  if (Array.isArray(body.securityQuestions)) {
    entries = body.securityQuestions;
  } else if (Array.isArray(body.answers)) {
    entries = body.answers;
  } else if (body.securityAnswers && typeof body.securityAnswers === "object") {
    entries = Object.entries(body.securityAnswers).map(([question, answer]) => ({ question, answer }));
  }

  const answerByQuestionKey = new Map();
  for (const item of entries) {
    const questionKey = normalizeQuestionKey(item?.question);
    const normalizedAnswer = String(item?.answer || "").trim().toLowerCase();

    if (!questionKey || !normalizedAnswer || !DEFAULT_SECURITY_QUESTION_KEY_MAP.has(questionKey)) continue;
    if (answerByQuestionKey.has(questionKey)) continue;

    answerByQuestionKey.set(questionKey, normalizedAnswer);
  }

  if (answerByQuestionKey.size !== DEFAULT_SECURITY_QUESTIONS.length) {
    return { error: `All ${DEFAULT_SECURITY_QUESTIONS.length} security question answers are required` };
  }

  const securityQuestions = [];
  for (const defaultQuestion of DEFAULT_SECURITY_QUESTIONS) {
    const questionKey = normalizeQuestionKey(defaultQuestion);
    const answer = answerByQuestionKey.get(questionKey);

    if (!answer) {
      return { error: "Security question set is incomplete" };
    }

    securityQuestions.push({
      question: defaultQuestion,
      answerHash: await bcrypt.hash(answer, 10),
    });
  }

  return { securityQuestions };
};

const countMatchedSecurityAnswers = async ({ answers, securityQuestions, requiredQuestionKeys }) => {
  const typedAnswers = buildAnswerMap(answers);
  const storedSecurityQuestionMap = new Map(
    getUniqueSecurityQuestions(securityQuestions).map((item) => [
      normalizeQuestionKey(item.question),
      item.answerHash,
    ]),
  );

  let matched = 0;
  for (const questionKey of requiredQuestionKeys) {
    const typedAnswer = typedAnswers.get(questionKey);
    const answerHash = storedSecurityQuestionMap.get(questionKey);

    if (!typedAnswer || !answerHash) continue;

    const isValid = await bcrypt.compare(typedAnswer, answerHash);
    if (isValid) matched += 1;
  }

  return matched;
};

const getStudentFromSecurityResetToken = async (resetToken) => {
  let decoded;
  try {
    decoded = verifyToken(resetToken, process.env.JWT_ACCESS_SECRET);
  } catch (error) {
    throw new AppError(401, "Invalid reset token");
  }

  if (decoded.flow !== "student-security-reset") {
    throw new AppError(401, "Invalid reset token flow");
  }

  const user = await User.findById(decoded._id).select("+password");
  if (!user || user.role !== "student") {
    throw new AppError(404, "Student not found");
  }

  return user;
};

const sanitizeUser = (user) => ({
  _id: user._id,
  name: user.name,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  userId: user.userId,
  role: user.role,
  status: user.status,
  school: user.school,
  gradeLevel: user.gradeLevel,
  lastLoginAt: user.lastLoginAt || null,
});

const createAuthTokens = (user) => {
  const jwtPayload = {
    _id: user._id,
    role: user.role,
  };

  const accessToken = createToken(jwtPayload, process.env.JWT_ACCESS_SECRET, ACCESS_EXPIRES_IN);
  const refreshToken = createToken(jwtPayload, process.env.JWT_REFRESH_SECRET, REFRESH_EXPIRES_IN);

  return { accessToken, refreshToken };
};

export const registerAdmin = catchAsync(async (req, res, next) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return next(new AppError(400, "Name, email and password are required"));
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const exists = await User.findOne({ email: normalizedEmail });
  if (exists) {
    return next(new AppError(409, "Admin already exists"));
  }

  const admin = await User.create({
    name,
    email: normalizedEmail,
    password,
    role: "admin",
    isEmailVerified: true,
    status: "active",
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Admin registered successfully",
    data: sanitizeUser(admin),
  });
});

export const login = catchAsync(async (req, res, next) => {
  const { email, userId, password, mac_id } = req.body;

  // Validate request
  if ((!email && !userId) || !password) {
    return next(
      new AppError(
        400,
        "email or userId and password are required"
      )
    );
  }

  // Find user
  const query = email
    ? { email: String(email).trim().toLowerCase() }
    : { userId: String(userId).trim().toUpperCase() };

  const user = await User.findOne(query).select(
    "+password +refreshToken"
  );

  if (!user) {
    return next(new AppError(401, "No user found"));
  }

  // Check account status
  if (user.status !== "active") {
    return next(new AppError(403, "Account is inactive"));
  }

  // Verify password
  const isMatch = await User.isPasswordMatched(password, user.password);

  if (!isMatch) {
    return next(new AppError(401, "Incorrect password"));
  }

  // Only admin can login using email
  if (email && user.role !== "admin") {
    return next(new AppError(403, "Only admin can login with email"));
  }

  // Device locking is for app users. Admin dashboard email login should not
  // require a client MAC/device identifier.
  if (user.role !== "admin") {
    if (!mac_id) {
      return next(new AppError(400, "mac_id is required"));
    }

    const incomingMacId = String(mac_id).trim().toUpperCase();

    // First login -> Register device
    if (!user.mac_id) {
      user.mac_id = incomingMacId;
    }
    // Later logins -> Verify device
    else if (user.mac_id !== incomingMacId) {
      return next(
        new AppError(
          403,
          "This account is already registered to another device."
        )
      );
    }
  }

  // Generate tokens
  const { accessToken, refreshToken } = createAuthTokens(user);

  user.refreshToken = refreshToken;
  user.lastLoginAt = new Date();

  await user.save();

  // Store refresh token in cookie
  res.cookie("refreshToken", refreshToken, {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });

  // Response
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Login successful",
    data: {
      accessToken,
      refreshToken,
      user: sanitizeUser(user),
    },
  });
});

export const refreshAccessToken = catchAsync(async (req, res, next) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) {
    return next(new AppError(401, "Refresh token is required"));
  }

  let decoded;
  try {
    decoded = verifyToken(token, process.env.JWT_REFRESH_SECRET);
  } catch (error) {
    return next(new AppError(401, "Invalid refresh token"));
  }

  const user = await User.findById(decoded._id).select("+refreshToken");
  if (!user || !user.refreshToken || user.refreshToken !== token) {
    return next(new AppError(401, "Refresh token does not match"));
  }

  const accessToken = createToken(
    { _id: user._id, role: user.role },
    process.env.JWT_ACCESS_SECRET,
    ACCESS_EXPIRES_IN,
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Access token refreshed",
    data: { accessToken },
  });
});

export const logout = catchAsync(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;

  if (token) {
    try {
      const decoded = verifyToken(token, process.env.JWT_REFRESH_SECRET);
      await User.findByIdAndUpdate(decoded._id, { refreshToken: "" });
    } catch (error) {
      // ignore invalid token on logout
    }
  }

  res.clearCookie("refreshToken", {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Logged out successfully",
  });
});

export const forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  if (!email) {
    return next(new AppError(400, "Email is required"));
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return next(new AppError(404, "No user found with this email"));
  }

  const otp = generateOTP();
  user.passwordResetOTP = {
    code: otp,
    expiry: new Date(Date.now() + 10 * 60 * 1000),
    verified: false,
  };
  await user.save();

  await sendOTP(user.email, otp);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "OTP sent successfully",
  });
});

export const verifyForgotPasswordOTP = catchAsync(async (req, res, next) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return next(new AppError(400, "Email and OTP are required"));
  }

  const user = await User.findOne({ email: String(email).trim().toLowerCase() });
  if (!user?.passwordResetOTP?.code) {
    return next(new AppError(404, "No OTP request found"));
  }

  if (user.passwordResetOTP.expiry && user.passwordResetOTP.expiry.getTime() < Date.now()) {
    return next(new AppError(400, "OTP expired"));
  }

  if (String(user.passwordResetOTP.code) !== String(otp).trim()) {
    return next(new AppError(400, "Invalid OTP"));
  }

  user.passwordResetOTP.verified = true;
  await user.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "OTP verified successfully",
  });
});

export const resetPassword = catchAsync(async (req, res, next) => {
  const { email, resetToken, newPassword, confirmPassword } = req.body;

  if (!newPassword || !confirmPassword) {
    return next(new AppError(400, "newPassword and confirmPassword are required"));
  }

  if (newPassword !== confirmPassword) {
    return next(new AppError(400, "Passwords do not match"));
  }

  let user;

  if (resetToken) {
    user = await getStudentFromSecurityResetToken(resetToken);
  } else {
    if (!email) {
      return next(new AppError(400, "Email is required when resetToken is not provided"));
    }

    user = await User.findOne({ email: String(email).trim().toLowerCase() }).select("+password");
    if (!user) {
      return next(new AppError(404, "No user found"));
    }

    if (!user.passwordResetOTP?.verified) {
      return next(new AppError(403, "OTP verification required"));
    }
  }

  user.password = newPassword;
  user.passwordResetOTP = { code: "", expiry: null, verified: false };
  await user.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Password reset successfully",
  });
});

export const saveStudentSecurityQuestions = catchAsync(async (req, res, next) => {
  const student = await Student.findOne({ user: req.user._id });
  if (!student) {
    return next(new AppError(404, "Student profile not found"));
  }

  const { securityQuestions, error } = await parseSecurityQuestionsForSave(req.body);
  if (error) {
    return next(new AppError(400, error));
  }

  student.securityQuestions = securityQuestions;
  await student.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Security questions saved successfully",
  });
});

export const verifyStudentSecurityAnswers = catchAsync(async (req, res, next) => {
  const { userId, answers } = req.body;

  if (!Array.isArray(answers) || answers.length === 0) {
    return next(new AppError(400, "answers are required"));
  }

  if (!userId) {
    return next(new AppError(400, "userId is required"));
  }

  const submittedQuestionKeys = [
    ...new Set(
      answers
        .map((item) => normalizeQuestionKey(item?.question))
        .filter(Boolean),
    ),
  ];

  if (submittedQuestionKeys.length !== 2) {
    return next(new AppError(400, "Exactly 2 security question answers are required"));
  }

  const normalizedUserId = String(userId).trim().toUpperCase();
  const user = await User.findOne({ userId: normalizedUserId, role: "student" });
  if (!user) {
    return next(new AppError(404, "Student not found"));
  }

  const student = await Student.findOne({ user: user._id });
  if (!student || !student.securityQuestions?.length) {
    return next(new AppError(400, "Security questions are not set for this student"));
  }

  const savedQuestionKeys = new Set(
    getUniqueSecurityQuestions(student.securityQuestions).map((item) => normalizeQuestionKey(item.question)),
  );

  const allSubmittedQuestionsAreValid = submittedQuestionKeys.every((key) => savedQuestionKeys.has(key));
  if (!allSubmittedQuestionsAreValid) {
    return next(new AppError(400, "Submitted questions must be from saved security questions"));
  }

  const matched = await countMatchedSecurityAnswers({
    answers,
    securityQuestions: student.securityQuestions,
    requiredQuestionKeys: submittedQuestionKeys,
  });

  if (matched !== submittedQuestionKeys.length) {
    return next(new AppError(401, "Security verification failed"));
  }

  const resetToken = createToken({ _id: user._id, role: user.role, flow: "student-security-reset" }, process.env.JWT_ACCESS_SECRET);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Identity verified successfully",
    data: {
      matched,
      resetToken,
      gradeLevel: student.gradeLevel,
    },
  });
});

export const resetStudentPasswordBySecurity = catchAsync(async (req, res, next) => {
  const { resetToken, newPassword, confirmPassword } = req.body;

  if (!resetToken || !newPassword || !confirmPassword) {
    return next(new AppError(400, "resetToken, newPassword and confirmPassword are required"));
  }

  if (newPassword !== confirmPassword) {
    return next(new AppError(400, "Passwords do not match"));
  }

  const user = await getStudentFromSecurityResetToken(resetToken);

  user.password = newPassword;
  user.passwordResetOTP = { code: "", expiry: null, verified: false };
  await user.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Password reset successfully",
  });
});

export const me = catchAsync(async (req, res) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile fetched successfully",
    data: sanitizeUser(req.user),
  });
});
