import jwt from "jsonwebtoken";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { User } from "./../model/user.model.js";

export const protect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) throw new AppError(httpStatus.NOT_FOUND, "Token not found");

  try {
    const decoded = await jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    // console.log(decoded)
    const user = await User.findById(decoded._id);
    if (user) {
      req.user = user;
    }
    next();
  } catch (err) {
    throw new AppError(401, "Invalid token");
  }
};

export const restrictTo =
  (...roles) =>
  (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(403, "You are not allowed to perform this action"),
      );
    }
    next();
  };

export const requireApprovedAccount = () => (req, res, next) => {
  if (req.user.status !== "approved") {
    return next(new AppError(403, "Account not approved"));
  }
  next();
};
