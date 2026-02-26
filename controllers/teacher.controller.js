import AppError from "../errors/AppError.js";
import { Course } from "../models/course.model.js";
import { Progress } from "../models/progress.model.js";
import { Student } from "../models/student.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";
import { Teacher } from "../models/teacher.model.js";
import { User } from "../models/user.model.js";
import { normalizeGradeLevel } from "../utils/grade.js";
import { parsePagination, getPaginationMeta } from "../utils/pagination.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";

const buildSearchRegex = (value) =>
  new RegExp(
    String(value)
      .trim()
      .replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"),
    "i",
  );

const getTeacherDoc = async (userId) =>
  Teacher.findOne({ user: userId })
    .populate("courses", "name")
    .populate("school", "name schoolCode");

const getStudentProgressSummary = async (studentId) => {
  const [summary] = await Progress.aggregate([
    { $match: { student: studentId } },
    {
      $group: {
        _id: null,
        totalActivities: { $sum: 1 },
        completedActivities: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
        totalMinutes: { $sum: "$activityMinutes" },
        avgQuizScore: {
          $avg: { $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null] },
        },
      },
    },
  ]);

  const bySubject = await Progress.aggregate([
    { $match: { student: studentId } },
    {
      $group: {
        _id: "$course",
        total: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: "courses",
        localField: "_id",
        foreignField: "_id",
        as: "course",
      },
    },
    { $unwind: "$course" },
    {
      $project: {
        _id: 0,
        subject: "$course.name",
        completionRate: {
          $cond: [
            { $eq: ["$total", 0] },
            0,
            {
              $round: [
                { $multiply: [{ $divide: ["$completed", "$total"] }, 100] },
                2,
              ],
            },
          ],
        },
      },
    },
  ]);

  return {
    summary: {
      totalActivities: summary?.totalActivities || 0,
      completedActivities: summary?.completedActivities || 0,
      totalHours: Number(((summary?.totalMinutes || 0) / 60 || 0).toFixed(2)),
      avgQuizScore: Number((summary?.avgQuizScore || 0).toFixed(2)),
      completionRate:
        summary?.totalActivities > 0
          ? Number(
              (
                (summary.completedActivities / summary.totalActivities) *
                100
              ).toFixed(2),
            )
          : 0,
    },
    subjectProgress: bySubject,
  };
};

export const getTeacherDashboard = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const studentFilter = { school: teacher.school?._id };
  if (teacher.gradeLevel) {
    studentFilter.gradeLevel = teacher.gradeLevel;
  }

  const [
    totalStudents,
    totalSubjects,
    totalCompleted,
    totalQuizCompleted,
    subjectOverview,
    studentsPerWeek,
  ] = await Promise.all([
    Student.countDocuments(studentFilter),
    teacher.courses?.length || 0,
    Progress.countDocuments({ status: "completed" }),
    Progress.countDocuments({ status: "completed", activityType: "quiz" }),
    Progress.aggregate([
      {
        $match: {
          status: "completed",
          course: { $in: (teacher.courses || []).map((c) => c._id) },
        },
      },
      { $group: { _id: "$course", completed: { $sum: 1 } } },
      {
        $lookup: {
          from: "courses",
          localField: "_id",
          foreignField: "_id",
          as: "course",
        },
      },
      { $unwind: "$course" },
      { $project: { _id: 0, subject: "$course.name", completed: 1 } },
      { $sort: { completed: -1 } },
    ]),
    Progress.aggregate([
      { $match: { status: "completed" } },
      { $project: { weekday: { $dayOfWeek: "$performedAt" } } },
      { $group: { _id: "$weekday", total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const weekMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weeklyStudents = weekMap.map((day, idx) => ({
    day,
    total: studentsPerWeek.find((item) => item._id === idx + 1)?.total || 0,
  }));

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Teacher dashboard fetched successfully",
    data: {
      teacher: {
        _id: teacher._id,
        name: teacher.name,
        school: teacher.school,
        gradeLevel: teacher.gradeLevel,
      },
      counters: {
        totalStudents,
        totalSubjects,
        lessonCompleted: totalCompleted,
        quizCompleted: totalQuizCompleted,
      },
      charts: {
        subjectOverview,
        weeklyStudents,
      },
    },
  });
});

export const getTeacherStudents = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const { page, limit, skip } = parsePagination(req.query);
  const filter = { school: teacher.school?._id };

  if (req.query.status) filter.status = req.query.status;
  if (req.query.gradeLevel)
    filter.gradeLevel = normalizeGradeLevel(req.query.gradeLevel);
  if (!req.query.gradeLevel && teacher.gradeLevel)
    filter.gradeLevel = teacher.gradeLevel;

  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    const users = await User.find(
      { role: "student", $or: [{ name: regex }, { userId: regex }] },
      { _id: 1 },
    );
    filter.$or = [{ name: regex }];
    if (users.length)
      filter.$or.push({ user: { $in: users.map((u) => u._id) } });
  }

  const [items, total] = await Promise.all([
    Student.find(filter)
      .populate("school", "name schoolCode")
      .populate("user", "userId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Student.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Students fetched successfully",
    data: {
      items: items.map((item) => ({
        _id: item._id,
        studentName: item.name,
        userId: item.user?.userId,
        schoolName: item.school?.name,
        gradeLevel: item.gradeLevel,
        status: item.status,
      })),
      meta: getPaginationMeta({ page, limit, total }),
    },
  });
});

export const getTeacherStudentById = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const student = await Student.findOne({
    _id: req.params.studentId,
    school: teacher.school?._id,
  })
    .populate("school", "name schoolCode")
    .populate("user", "name userId")
    .lean();

  if (!student) return next(new AppError(404, "Student not found"));

  const progressSheet = await getStudentProgressSummary(student._id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Student details fetched successfully",
    data: {
      student: {
        _id: student._id,
        studentName: student.name,
        userId: student.user?.userId,
        schoolName: student.school?.name,
        schoolCode: student.school?.schoolCode,
        gradeLevel: student.gradeLevel,
        status: student.status,
      },
      progressSheet,
    },
  });
});

export const getTeacherSubjects = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Subjects fetched successfully",
    data: teacher.courses || [],
  });
});

export const getTeacherPrivacyPolicy = catchAsync(async (req, res) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Privacy policy fetched successfully",
    data: {
      title: "Privacy Policy",
      content:
        "Control who can see your progress. We collect only the data needed to provide lesson progress, quiz performance, and support services.",
    },
  });
});

export const createTeacherSupportTicket = catchAsync(async (req, res, next) => {
  const { subject, description } = req.body;

  if (!subject || !description) {
    return next(new AppError(400, "subject and description are required"));
  }

  const ticket = await SupportTicket.create({
    user: req.user._id,
    role: "teacher",
    userId: req.user.userId || "",
    subject,
    description,
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Support ticket created successfully",
    data: ticket,
  });
});

export const getTeacherProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  const teacher = await getTeacherDoc(req.user._id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile fetched successfully",
    data: {
      user,
      teacher,
    },
  });
});

export const updateTeacherProfile = catchAsync(async (req, res) => {
  const payload = {};
  for (const key of ["name", "firstName", "lastName", "email"]) {
    if (req.body[key] !== undefined) payload[key] = req.body[key];
  }

  if (payload.email) payload.email = String(payload.email).trim().toLowerCase();

  if (req.files?.profile) {
    const upload = await uploadOnCloudinary(
      req.files.profile[0].buffer,
      "teacher_profiles",
    );
    payload.profile = { public_id: upload.public_id, url: upload.secure_url };
  }

  if (req.files?.file) {
    const upload = await uploadOnCloudinary(
      req.files.file[0].buffer,
      "teacher_files",
    );
    payload.file = { public_id: upload.public_id, url: upload.secure_url };
  }

  const user = await User.findByIdAndUpdate(req.user._id, payload, {
    new: true,
  });
  const teacher = await Teacher.findOneAndUpdate(
    { user: req.user._id },
    { name: payload.name || req.body.teacherName || undefined },
    { new: true },
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile updated successfully",
    data: { user, teacher },
  });
});

export const changeTeacherPassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return next(
      new AppError(
        400,
        "currentPassword, newPassword and confirmPassword are required",
      ),
    );
  }

  if (newPassword !== confirmPassword) {
    return next(new AppError(400, "Passwords do not match"));
  }

  const user = await User.findById(req.user._id).select("+password");
  if (!user) return next(new AppError(404, "User not found"));

  const matched = await User.isPasswordMatched(currentPassword, user.password);
  if (!matched) return next(new AppError(400, "Current password is incorrect"));

  user.password = newPassword;
  await user.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Password changed successfully",
  });
});

export const getTeacherCourseCatalog = catchAsync(async (req, res) => {
  const courses = await Course.find({ status: "active" }).sort({ name: 1 });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Course catalog fetched successfully",
    data: courses,
  });
});
