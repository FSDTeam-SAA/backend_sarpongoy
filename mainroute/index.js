import express from "express";
import adminRoute from "../route/admin.route.js";
import authRoute from "../route/auth.route.js";
import studentRoute from "../route/student.route.js";
import teacherRoute from "../route/teacher.route.js";

const router = express.Router();

router.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "API is running",
    timestamp: new Date().toISOString(),
  });
});

router.use("/auth", authRoute);
router.use("/admin", adminRoute);
router.use("/teacher", teacherRoute);
router.use("/student", studentRoute);

router.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

export default router;
