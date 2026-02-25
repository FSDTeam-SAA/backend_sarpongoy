import express from "express";
import {
  forgotPassword,
  login,
  logout,
  me,
  refreshAccessToken,
  registerAdmin,
  resetPassword,
  resetStudentPasswordBySecurity,
  saveStudentSecurityQuestions,
  verifyForgotPasswordOTP,
  verifyStudentSecurityAnswers,
} from "../controllers/auth.controller.js";
import { protect, restrictTo } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/register-admin", registerAdmin);
router.post("/login", login);
router.post("/refresh-token", refreshAccessToken);
router.post("/logout", logout);
router.post("/forgot-password", forgotPassword);
router.post("/verify-otp", verifyForgotPasswordOTP);
router.post("/reset-password", resetPassword);
router.post("/student/security-questions", protect, restrictTo("student"), saveStudentSecurityQuestions);
router.post("/student/verify-security", verifyStudentSecurityAnswers);
router.post("/student/reset-password", resetStudentPasswordBySecurity);
router.get("/me", protect, me);

export default router;
