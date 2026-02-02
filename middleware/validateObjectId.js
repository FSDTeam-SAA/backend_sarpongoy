import mongoose from "mongoose";
import AppError from "../utils/AppError.js";

export const validateObjectId = (paramName) => (req, res, next) => {
  const id = req.params[paramName];
  if (!mongoose.Types.ObjectId.isValid(id))
    return next(new AppError(400, "Invalid id"));
  next();
};
