import jwt from "jsonwebtoken";
import AppError from "../errors/AppError.js";
import { User } from "../models/user.model.js";

export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

    if (!token) {
      return next(new AppError(401, "Token not found"));
    }

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded._id || decoded.id).select("+refreshToken");

    if (!user) {
      return next(new AppError(401, "User no longer exists"));
    }

    req.user = user;
    next();
  } catch (error) {
    next(new AppError(401, "Invalid token"));
  }
};

export const restrictTo =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, "You are not allowed to perform this action"));
    }
    next();
  };

export const requireActiveAccount = () => (req, res, next) => {
  if (req.user?.status !== "active") {
    return next(new AppError(403, "Account is inactive"));
  }
  next();
};
