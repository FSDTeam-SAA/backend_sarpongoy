import express from "express";
import {
  addCourse,
  addLesson,
  addNewStudent,
  addNewTeacher,
  addSchool,
  changeMyPassword,
  deleteCourse,
  deleteLesson,
  deleteSchool,
  deleteStudent,
  deleteTeacher,
  getAdminDashboard,
  getCourses,
  getMyProfile,
  getSchools,
  getLessons,
  getStudentById,
  getStudents,
  getSupportTickets,
  getTeacherById,
  getTeachers,
  resolveSupportTicket,
  updateCourse,
  updateLesson,
  updateMyProfile,
  updateSchool,
  updateStudent,
  updateTeacher,
} from "../controllers/admin.controller.js";
import { protect, restrictTo } from "../middleware/auth.middleware.js";
import upload from "../middleware/multer.middleware.js";

const router = express.Router();

router.use(protect, restrictTo("admin"));

router.get("/dashboard", getAdminDashboard);

router.post(
  "/students",
  upload.fields([{ name: "picture" }, { name: "file" }]),
  addNewStudent,
);
router.get("/students", getStudents);
router.get("/students/:studentId", getStudentById);
router.patch(
  "/students/:studentId",
  upload.fields([{ name: "picture" }, { name: "file" }]),
  updateStudent,
);
router.delete("/students/:studentId", deleteStudent);

router.post(
  "/teachers",
  upload.fields([{ name: "picture" }, { name: "file" }]),
  addNewTeacher,
);
router.get("/teachers", getTeachers);
router.get("/teachers/:teacherId", getTeacherById);
router.patch(
  "/teachers/:teacherId",
  upload.fields([{ name: "picture" }, { name: "file" }]),
  updateTeacher,
);
router.delete("/teachers/:teacherId", deleteTeacher);

router.post("/schools", addSchool);
router.get("/schools", getSchools);
router.patch("/schools/:schoolId", updateSchool);
router.delete("/schools/:schoolId", deleteSchool);

router.post("/courses", addCourse);
router.get("/courses", getCourses);
router.patch("/courses/:courseId", updateCourse);
router.delete("/courses/:courseId", deleteCourse);

router.post("/lessons", addLesson);
router.get("/lessons", getLessons);
router.patch("/lessons/:lessonId", updateLesson);
router.delete("/lessons/:lessonId", deleteLesson);

router.get("/profile", getMyProfile);
router.patch("/profile", upload.fields([{ name: "picture" }]), updateMyProfile);
router.patch("/change-password", changeMyPassword);

router.get("/support-tickets", getSupportTickets);
router.patch("/support-tickets/:ticketId", resolveSupportTicket);

export default router;
