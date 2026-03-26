import mongoose from "mongoose";
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

const getStudentProgressSummary = async (studentId, courseId = null) => {
  const match = { student: studentId };
  if (courseId) match.course = courseId;

  const [summary] = await Progress.aggregate([
    { $match: match },
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
    { $match: match },
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
      avgDailyHours: Number(
        (((summary?.totalMinutes || 0) / 60 / 7) || 0).toFixed(2),
      ),
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

const getCourseWiseOverview = async (studentId, courseId = null) => {
  const match = { student: studentId };
  if (courseId) match.course = courseId;

  return Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$course",
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
        courseId: "$course._id",
        subject: "$course.name",
        activityCount: "$totalActivities",
        totalHours: { $round: [{ $divide: ["$totalMinutes", 60] }, 2] },
        avgQuizScore: { $round: ["$avgQuizScore", 2] },
        completionRate: {
          $cond: [
            { $eq: ["$totalActivities", 0] },
            0,
            {
              $round: [
                {
                  $multiply: [
                    { $divide: ["$completedActivities", "$totalActivities"] },
                    100,
                  ],
                },
                2,
              ],
            },
          ],
        },
      },
    },
    { $sort: { subject: 1 } },
  ]);
};

const buildWeeklyActivitySeries = async (match) => {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - 6);

  const pipeline = [
    {
      $match: {
        ...match,
        performedAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$performedAt" } },
          weekday: { $dayOfWeek: "$performedAt" },
        },
        totalMinutes: { $sum: "$activityMinutes" },
        activityCount: { $sum: 1 },
        avgQuizScore: {
          $avg: { $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id.day",
        weekday: "$_id.weekday",
        activityCount: 1,
        totalHours: { $round: [{ $divide: ["$totalMinutes", 60] }, 2] },
        avgQuizScore: { $round: ["$avgQuizScore", 2] },
      },
    },
    { $sort: { date: 1 } },
  ];

  const raw = await Progress.aggregate(pipeline);

  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const dateObj = new Date(now);
    dateObj.setDate(now.getDate() - i);
    const iso = dateObj.toISOString().slice(0, 10);
    const found = raw.find((item) => item.date === iso);
    days.push({
      label: dayLabels[dateObj.getDay()],
      date: iso,
      activityCount: found?.activityCount || 0,
      totalHours: found?.totalHours || 0,
      avgQuizScore: found?.avgQuizScore || 0,
    });
  }

  const totals = days.reduce(
    (acc, cur) => ({
      activityCount: acc.activityCount + cur.activityCount,
      totalHours: Number((acc.totalHours + cur.totalHours).toFixed(2)),
      avgQuizScore:
        acc.avgQuizScore + (Number(cur.avgQuizScore) || 0) / days.length,
    }),
    { activityCount: 0, totalHours: 0, avgQuizScore: 0 },
  );

  return {
    days,
    totals: {
      ...totals,
      avgQuizScore: Number(totals.avgQuizScore.toFixed(2)),
      avgDailyHours: Number((totals.totalHours / days.length).toFixed(2)),
    },
  };
};

const getMonthlyCompletionByCourse = async (courseIds, filterCourseId = null) => {
  if (!courseIds.length) return [];
  const targetCourseIds = filterCourseId ? [filterCourseId] : courseIds;

  const docs = await Progress.aggregate([
    {
      $match: {
        status: "completed",
        course: { $in: targetCourseIds.map(id => new mongoose.Types.ObjectId(id)) },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: "$performedAt" },
          month: { $month: "$performedAt" },
        },
        completed: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        year: "$_id.year",
        month: "$_id.month",
        completed: 1,
      },
    },
    { $sort: { year: 1, month: 1 } },
  ]);

  const monthMap = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const currentYear = new Date().getFullYear();
  const fullYearData = monthMap.map((label, idx) => {
    const monthIndex = idx + 1;
    const found = docs.find(d => d.month === monthIndex && d.year === currentYear);
    return {
      month: label,
      completed: found ? found.completed : 0,
    };
  });

  return fullYearData;
};

const getSubjectRecentWork = async (studentId, courseId = null) => {
  const match = { student: studentId };
  if (courseId) match.course = courseId;

  return Progress.aggregate([
    { $match: match },
    { $sort: { performedAt: -1 } },
    {
      $group: {
        _id: "$course",
        activities: {
          $push: {
            type: "$activityType",
            score: "$score",
            originalScore: "$originalScore",
            total: "$totalQuestions",
          },
        },
      },
    },
    {
      $project: {
        practice: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$activities",
                as: "a",
                cond: { $eq: ["$$a.type", "practice"] },
              },
            },
            0,
          ],
        },
        quiz: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$activities",
                as: "a",
                cond: { $eq: ["$$a.type", "quiz"] },
              },
            },
            0,
          ],
        },
        quizzes: {
          $filter: {
            input: "$activities",
            as: "a",
            cond: {
              $and: [{ $eq: ["$$a.type", "quiz"] }, { $ne: ["$$a.score", null] }],
            },
          },
        },
      },
    },
    {
      $project: {
        practice: 1,
        quiz: 1,
        lowestQuiz: {
          $reduce: {
            input: "$quizzes",
            initialValue: null,
            in: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$$value", null] },
                    { $lt: ["$$this.score", "$$value.score"] },
                  ],
                },
                "$$this",
                "$$value",
              ],
            },
          },
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
        courseId: "$_id",
        subject: "$course.name",
        practice: 1,
        quiz: 1,
        lowestQuiz: 1,
      },
    },
    { $sort: { subject: 1 } },
  ]);
};

export const getTeacherDashboard = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const { courseId } = req.query;
  const studentFilter = { school: teacher.school?._id };
  if (teacher.gradeLevel) {
    studentFilter.gradeLevel = teacher.gradeLevel;
  }

  const students = await Student.find(studentFilter).select("_id").lean();
  const studentIds = students.map((s) => s._id);

  const progressMatch = {
    status: "completed",
    student: { $in: studentIds },
  };

  const allCourses = await Course.find({ status: "active" }).select("_id").lean();
  const courseIds = allCourses.map((c) => c._id);

  if (courseId) {
    progressMatch.course = courseId;
  }

  const now = new Date();
  const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [
    totalStudents,
    prevMonthStudents,
    totalSubjects,
    totalCompleted,
    prevMonthCompleted,
    totalQuizCompleted,
    prevMonthQuizCompleted,
    subjectOverview,
    studentsPerWeek,
    monthlyCompletionTrend,
    milestone,
  ] = await Promise.all([
    Student.countDocuments(studentFilter),
    Student.countDocuments({ ...studentFilter, createdAt: { $lt: startOfCurrentMonth, $gte: startOfPrevMonth } }),
    Course.countDocuments({ status: "active" }),
    Progress.countDocuments(progressMatch),
    Progress.countDocuments({ ...progressMatch, performedAt: { $lt: startOfCurrentMonth, $gte: startOfPrevMonth } }),
    Progress.countDocuments({ ...progressMatch, activityType: "quiz" }),
    Progress.countDocuments({ ...progressMatch, activityType: "quiz", performedAt: { $lt: startOfCurrentMonth, $gte: startOfPrevMonth } }),
    Progress.aggregate([
      { $match: progressMatch },
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
      { $match: { status: "completed", course: { $in: courseIds } } },
      { $project: { weekday: { $dayOfWeek: "$performedAt" } } },
      { $group: { _id: "$weekday", total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    getMonthlyCompletionByCourse(courseIds, courseId),
    Progress.findOne({ ...progressMatch, ...(courseId && { course: courseId }) })
      .populate("lesson", "title strand subStrand lessonNumber")
      .sort({ performedAt: -1 })
      .lean(),
  ]);

  const calculateGrowth = (current, previous) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Number((((current - previous) / previous) * 100).toFixed(0));
  };

  // Note: For students and lessons, we usually want "growth in completions/signups this month" 
  // vs "completions/signups last month".
  const currentMonthStudents = await Student.countDocuments({ ...studentFilter, createdAt: { $gte: startOfCurrentMonth } });
  const currentMonthCompleted = await Progress.countDocuments({ ...progressMatch, performedAt: { $gte: startOfCurrentMonth } });
  const currentMonthQuizCompleted = await Progress.countDocuments({ ...progressMatch, activityType: "quiz", performedAt: { $gte: startOfCurrentMonth } });

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
        totalStudentsGrowth: calculateGrowth(currentMonthStudents, prevMonthStudents),
        totalSubjects,
        totalSubjectsGrowth: 0, // Subjects growth is typically static unless new modules are added
        lessonCompleted: totalCompleted,
        lessonCompletedGrowth: calculateGrowth(currentMonthCompleted, prevMonthCompleted),
        quizCompleted: totalQuizCompleted,
        quizCompletedGrowth: calculateGrowth(currentMonthQuizCompleted, prevMonthQuizCompleted),
      },
      charts: {
        subjectOverview,
        weeklyStudents,
        monthlyCompletionTrend,
        milestone: milestone ? {
          date: milestone.performedAt,
          strand: milestone.strandName || milestone.lesson?.strand,
          subStrand: milestone.subStrandName || milestone.lesson?.subStrand,
          lesson: milestone.lesson?.title,
          progress: {
            getReady: 100, // Based on image, completion implies 100%
            learn: 100,
            practice: milestone.activityType === 'practice' || milestone.activityType === 'quiz' ? 100 : 0,
            quiz: milestone.activityType === 'quiz' ? 100 : 0
          }
        } : null
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

export const getTeacherStudentOverview = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const { courseId } = req.query;
  if (courseId) {
    const hasCourse = await Course.exists({ _id: courseId, status: "active" });
    if (!hasCourse) {
      return next(new AppError(404, "Course not found or inactive"));
    }
  }

  const student = await Student.findOne({
    _id: req.params.studentId,
    school: teacher.school?._id,
  })
    .populate("school", "name schoolCode")
    .populate("user", "name userId status")
    .lean();

  if (!student) return next(new AppError(404, "Student not found"));

  const matchBase = { student: student._id };
  if (courseId) matchBase.course = courseId;

  const [
    progressSheet,
    courseWiseOverview,
    weeklyActivity,
    recentWork,
    activityBreakdown,
    subjectRecentWork,
  ] = await Promise.all([
    getStudentProgressSummary(student._id, courseId),
    getCourseWiseOverview(student._id, courseId),
    buildWeeklyActivitySeries(matchBase),
    Progress.find(matchBase)
      .populate("course", "name")
      .populate("lesson", "title strand subStrand lessonNumber")
      .sort({ performedAt: -1 })
      .limit(10)
      .lean(),
    Progress.aggregate([
      { $match: matchBase },
      {
        $group: {
          _id: "$activityType",
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          activityType: "$_id",
          total: 1,
          completed: 1,
        },
      },
    ]),
    getSubjectRecentWork(student._id, courseId),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Student overview fetched successfully",
    data: {
      student: {
        _id: student._id,
        studentName: student.name,
        userId: student.user?.userId,
        schoolName: student.school?.name,
        schoolCode: student.school?.schoolCode,
        gradeLevel: student.gradeLevel,
        status: student.status,
        picture: student.picture,
      },
      overview: {
        summary: progressSheet.summary,
        subjectProgress: progressSheet.subjectProgress,
        courseWiseOverview,
        weeklyActivity,
        activityBreakdown,
        subjectRecentWork,
        recentWork: recentWork.map((item) => ({
          _id: item._id,
          subject: item.course?.name,
          activityType: item.activityType,
          status: item.status,
          score: item.score,
          performedAt: item.performedAt,
          lesson: item.lesson
            ? {
                title: item.lesson.title,
                strand: item.lesson.strand,
                subStrand: item.lesson.subStrand,
                lessonNumber: item.lesson.lessonNumber,
              }
            : null,
        })),
      },
    },
  });
});

export const getTeacherSubjects = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const courses = await Course.find({ status: "active" })
    .select("_id name description gradeLevels")
    .sort({ name: 1 })
    .lean();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Subjects fetched successfully",
    data: courses,
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

export const updateTeacherProfile = catchAsync(async (req, res, next) => {
  const userPayload = {};
  const teacherPayload = {};
  for (const key of ["firstName", "lastName", "phone", "bio"]) {
    if (req.body[key] !== undefined) {
      userPayload[key] = req.body[key];
      teacherPayload[key] = req.body[key];
    }
  }

  const teacherDoc = await Teacher.findOne({ user: req.user._id });
  if (!teacherDoc) {
    return next(new AppError(404, "Teacher profile not found"));
  }

  if (req.files?.picture?.[0]) {
    const upload = await uploadOnCloudinary(
      req.files.picture[0].buffer,
      "profiles",
    );
    teacherPayload.picture = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  if (req.files?.file?.[0]) {
    const upload = await uploadOnCloudinary(req.files.file[0].buffer, "files");
    teacherPayload.file = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  const [user, teacher] = await Promise.all([
    User.findByIdAndUpdate(req.user._id, userPayload, {
      new: true,
    }),
    Teacher.findOneAndUpdate(
      { user: req.user._id },
      { $set: teacherPayload },
      { new: true },
    ),
  ]);

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
