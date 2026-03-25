import express from "express";
import {
  createStudentSupportTicket,
  getStudentCourseContent,
  getStudentHome,
  getStudentOnboarding,
  getStudentPrivacyPolicy,
  getStudentProfile,
  getStudentProgress,
  getStudentSubjectProgress,
  saveStudentActivity,
  syncStudentActivities,
  updateStudentProfile,
} from "../controllers/student.controller.js";
import { protect, restrictTo } from "../middleware/auth.middleware.js";
import upload from "../middleware/multer.middleware.js";

const router = express.Router();

router.get("/onboarding", getStudentOnboarding);

router.use(protect, restrictTo("student"));

router.get("/home", getStudentHome);
router.get("/courses/:courseId", getStudentCourseContent);
router.post("/activities", saveStudentActivity);
router.post("/activities/sync", syncStudentActivities);

router.get("/progress", getStudentProgress);
router.get("/progress/subject/:courseId", getStudentSubjectProgress);

router.get("/profile", getStudentProfile);
router.patch(
  "/profile",
  upload.fields([{ name: "picture" }, { name: "file" }]),
  updateStudentProfile,
);

router.get("/privacy-policy", getStudentPrivacyPolicy);
router.post("/support", createStudentSupportTicket);

export default router;
