import AppError from "../errors/AppError.js";
import { User } from "../models/user.model.js";
import { createToken } from "../utils/authToken.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";

export const registerAdmin = catchAsync(async (req, res, next) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return next(new AppError(400, "Name, email and password are required"));
  }

  const exists = await User.findOne({ email });
  if (exists) {
    return next(new AppError(409, "Admin already exists"));
  }

  const admin = await User.create({
    name,
    email,
    password,
    role: "admin",
    isEmailVerified: true,
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Admin registered successfully",
    data: {
      id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    },
  });
});

export const login = catchAsync(async (req, res, next) => {
  const { email, userId, password } = req.body;

  // Decide login strategy
  const query = email ? { email } : { userId };

  const user = await User.findOne(query).select("+password");
  if (!user) {
    return next(new AppError(401, "No user found"));
  }

  const isMatch = await User.isPasswordMatched(password, user.password);

  if (!isMatch) {
    return next(new AppError(401, "Incorrect password"));
  }

  // Optional: block non-admin email login
  if (email && user.role !== "admin") {
    return next(new AppError(403, "Only admin can login with email"));
  }

  const jwtPayload = {
    _id: user._id,
    role: user.role,
  };
  const accessToken = createToken(
    jwtPayload,
    process.env.JWT_ACCESS_SECRET,
    process.env.JWT_ACCESS_EXPIRES_IN,
  );

  const refreshToken = createToken(
    jwtPayload,
    process.env.JWT_REFRESH_SECRET,
    process.env.JWT_REFRESH_EXPIRES_IN,
  );

  user.refreshToken = refreshToken;
  let _user = await user.save();

  res.cookie("refreshToken", refreshToken, {
    secure: true,
    httpOnly: true,
    sameSite: "none",
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Login successful",
    data: {
      accessToken: accessToken,
      refreshToken: refreshToken,
      user: {
        _id: _user._id,
        name: _user.name,
        email: role === "admin" ? _user.email : _user.userId,
        role: _user.role,
      },
    },
  });
});
