import express from "express";
import {
  changeTeacherPassword,
  createTeacherSupportTicket,
  getTeacherCourseCatalog,
  getTeacherDashboard,
  getTeacherPrivacyPolicy,
  getTeacherProfile,
  getTeacherStudentById,
  getTeacherStudents,
  getTeacherSubjects,
  updateTeacherProfile,
} from "../controllers/teacher.controller.js";
import { protect, restrictTo } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect, restrictTo("teacher"));

router.get("/dashboard", getTeacherDashboard);
router.get("/subjects", getTeacherSubjects);
router.get("/courses/catalog", getTeacherCourseCatalog);
router.get("/students", getTeacherStudents);
router.get("/students/:studentId", getTeacherStudentById);

router.get("/privacy-policy", getTeacherPrivacyPolicy);
router.post("/support", createTeacherSupportTicket);

router.get("/profile", getTeacherProfile);
router.patch("/profile", updateTeacherProfile);
router.patch("/change-password", changeTeacherPassword);

export default router;
