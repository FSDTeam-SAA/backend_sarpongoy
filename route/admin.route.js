import express from "express";
import {
  addCourse,
  addLesson,
  addBulkSchools,
  addBulkStudents,
  addBulkTeachers,
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
  getSchoolsExport,
  getLessons,
  getStudentById,
  getStudents,
  getStudentsExport,
  getSupportTickets,
  getTeacherById,
  getTeacherOverview,
  getTeachers,
  getTeachersExport,
  resolveSupportTicket,
  updateCourse,
  updateLesson,
  updateMyProfile,
  updateSchool,
  updateSchoolsGradeLevel,
  updateStudent,
  updateStudentsGradeLevel,
  updateTeacher,
  updateTeachersGradeLevel,
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
router.post("/students/bulk", addBulkStudents);
router.patch("/students/bulk/grade-level", updateStudentsGradeLevel);
router.get("/students", getStudents);
router.get("/students/export", getStudentsExport);
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
router.post("/teachers/bulk", addBulkTeachers);
router.patch("/teachers/bulk/grade-level", updateTeachersGradeLevel);
router.get("/teachers", getTeachers);
router.get("/teachers/export", getTeachersExport);
router.get("/teachers/:teacherId", getTeacherById);
router.get("/teachers/:teacherId/overview", getTeacherOverview);
router.patch(
  "/teachers/:teacherId",
  upload.fields([{ name: "picture" }, { name: "file" }]),
  updateTeacher,
);
router.delete("/teachers/:teacherId", deleteTeacher);

router.post("/schools", addSchool);
router.post("/schools/bulk", addBulkSchools);
router.patch("/schools/bulk/grade-level", updateSchoolsGradeLevel);
router.get("/schools", getSchools);
router.get("/schools/export", getSchoolsExport);
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
