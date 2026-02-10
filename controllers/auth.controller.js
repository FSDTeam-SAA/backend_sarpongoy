import bcrypt from "bcryptjs";
import AppError from "../errors/AppError.js";
import { User } from "../models/user.model.js";
import { Student } from "../models/student.model.js";
import { createToken, verifyToken } from "../utils/authToken.js";
import { generateOTP, sendOTP } from "../utils/commonMethod.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";

const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_ACCESS_EXPIRY || "15m";
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || process.env.JWT_REFRESH_EXPIRY || "7d";

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
  const { email, userId, password } = req.body;

  if ((!email && !userId) || !password) {
    return next(new AppError(400, "email or userId and password are required"));
  }

  const query = email
    ? { email: String(email).trim().toLowerCase() }
    : { userId: String(userId).trim().toUpperCase() };

  const user = await User.findOne(query).select("+password +refreshToken");
  if (!user) {
    return next(new AppError(401, "No user found"));
  }

  if (user.status !== "active") {
    return next(new AppError(403, "Account is inactive"));
  }

  const isMatch = await User.isPasswordMatched(password, user.password);
  if (!isMatch) {
    return next(new AppError(401, "Incorrect password"));
  }

  if (email && user.role !== "admin") {
    return next(new AppError(403, "Only admin can login with email"));
  }

  const { accessToken, refreshToken } = createAuthTokens(user);
  user.refreshToken = refreshToken;
  await user.save();

  res.cookie("refreshToken", refreshToken, {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });

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
  const { email, newPassword, confirmPassword } = req.body;

  if (!email || !newPassword || !confirmPassword) {
    return next(new AppError(400, "Email, newPassword and confirmPassword are required"));
  }

  if (newPassword !== confirmPassword) {
    return next(new AppError(400, "Passwords do not match"));
  }

  const user = await User.findOne({ email: String(email).trim().toLowerCase() }).select("+password");
  if (!user) {
    return next(new AppError(404, "No user found"));
  }

  if (!user.passwordResetOTP?.verified) {
    return next(new AppError(403, "OTP verification required"));
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

export const verifyStudentSecurityAnswers = catchAsync(async (req, res, next) => {
  const { userId, answers } = req.body;

  if (!userId || !Array.isArray(answers) || answers.length === 0) {
    return next(new AppError(400, "userId and answers are required"));
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

  const normalizedAnswerMap = new Map();
  for (const item of answers) {
    if (item?.question && item?.answer) {
      normalizedAnswerMap.set(String(item.question).trim().toLowerCase(), String(item.answer).trim().toLowerCase());
    }
  }

  let matched = 0;
  for (const question of student.securityQuestions) {
    const typedAnswer = normalizedAnswerMap.get(String(question.question).trim().toLowerCase());
    if (!typedAnswer) continue;
    const ok = await bcrypt.compare(typedAnswer, question.answerHash);
    if (ok) matched += 1;
  }

  if (matched < 3) {
    return next(new AppError(401, "Security verification failed"));
  }

  const resetToken = createToken(
    { _id: user._id, role: user.role, flow: "student-security-reset" },
    process.env.JWT_ACCESS_SECRET,
    "15m",
  );

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

  let decoded;
  try {
    decoded = verifyToken(resetToken, process.env.JWT_ACCESS_SECRET);
  } catch (error) {
    return next(new AppError(401, "Invalid or expired reset token"));
  }

  if (decoded.flow !== "student-security-reset") {
    return next(new AppError(401, "Invalid reset token flow"));
  }

  const user = await User.findById(decoded._id).select("+password");
  if (!user || user.role !== "student") {
    return next(new AppError(404, "Student not found"));
  }

  user.password = newPassword;
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
