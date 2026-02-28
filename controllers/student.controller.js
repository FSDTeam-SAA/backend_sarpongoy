import AppError from "../errors/AppError.js";
import { Course } from "../models/course.model.js";
import { Lesson } from "../models/lesson.model.js";
import { Progress } from "../models/progress.model.js";
import { Student } from "../models/student.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";
import { User } from "../models/user.model.js";
import { normalizeGradeLevel } from "../utils/grade.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";

const ensureStudent = async (userId) => {
  const student = await Student.findOne({ user: userId })
    .populate("school", "name schoolCode")
    .populate("user", "name userId status gradeLevel");
  if (!student) {
    throw new AppError(404, "Student profile not found");
  }
  return student;
};

const getCourseCompletion = async (studentId) => {
  return Progress.aggregate([
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
      $project: {
        courseId: "$_id",
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
};

const getSummary = async (studentId) => {
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

  return {
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
  };
};

const buildTimelineFilter = (period) => {
  const now = new Date();
  if (period === "past_1_week") {
    return { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
  }
  if (period === "past_1_month") {
    return { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
  }
  if (period === "past_3_month") {
    return { $gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) };
  }
  if (period === "past_1_year") {
    return { $gte: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000) };
  }
  return null;
};

export const getStudentOnboarding = catchAsync(async (req, res) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Onboarding data fetched successfully",
    data: [
      {
        id: "mathematics",
        title: "Mathematics",
        subtitle: "Interactive Lessons",
        description: "Learn anytime, anywhere even without internet.",
      },
      {
        id: "social-studies",
        title: "Social Studies",
        subtitle: "Interactive Lessons",
        description: "Download lessons once and use them offline.",
      },
      {
        id: "science",
        title: "Science",
        subtitle: "Interactive Lessons",
        description: "Practice and quiz to measure progress.",
      },
    ],
  });
});

export const getStudentHome = catchAsync(async (req, res) => {
  const student = await ensureStudent(req.user._id);

  const gradeLevel = normalizeGradeLevel(
    req.query.gradeLevel || student.gradeLevel,
  );
  const search = req.query.search ? String(req.query.search).trim() : "";

  const courseFilter = {
    status: "active",
    $or: [{ gradeLevels: gradeLevel }, { gradeLevels: { $size: 0 } }],
  };
  if (search) {
    const regex = new RegExp(
      search.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"),
      "i",
    );
    courseFilter.$and = [{ $or: [{ name: regex }, { description: regex }] }];
  }

  const courses = await Course.find(courseFilter).sort({ name: 1 }).lean();
  const courseIds = courses.map((course) => course._id);

  const lessons = await Lesson.find({
    status: "active",
    course: { $in: courseIds },
    gradeLevel,
  })
    .sort({ strand: 1, subStrand: 1, lessonNumber: 1 })
    .lean();

  const lessonIds = lessons.map((lesson) => lesson._id);
  const progressRows = await Progress.find({
    student: student._id,
    lesson: { $in: lessonIds },
  }).lean();

  const progressMap = new Map();
  for (const item of progressRows) {
    progressMap.set(`${item.lesson}_${item.activityType}`, item);
  }

  const courseCompletion = await getCourseCompletion(student._id);
  const completionMap = new Map(
    courseCompletion.map((item) => [
      String(item.courseId),
      item.completionRate,
    ]),
  );

  const lessonsByCourse = new Map();
  for (const lesson of lessons) {
    const key = String(lesson.course);
    if (!lessonsByCourse.has(key)) lessonsByCourse.set(key, []);

    const activities = [
      "get_ready",
      "learn",
      "practice",
      "quiz",
      "resource",
    ].map((activityType) => {
      const record = progressMap.get(`${lesson._id}_${activityType}`);
      return {
        activityType,
        status: record?.status || "todo",
        score: record?.score ?? null,
        completedAt: record?.completedAt || null,
      };
    });

    lessonsByCourse.get(key).push({
      _id: lesson._id,
      strand: lesson.strand,
      subStrand: lesson.subStrand,
      lessonNumber: lesson.lessonNumber,
      title: lesson.title,
      description: lesson.description,
      activities,
    });
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Student home fetched successfully",
    data: {
      student: {
        _id: student._id,
        name: student.name,
        userId: student.user?.userId,
        gradeLevel: student.gradeLevel,
        schoolName: student.school?.name,
      },
      courses: courses.map((course) => ({
        _id: course._id,
        name: course.name,
        description: course.description,
        completionRate: completionMap.get(String(course._id)) || 0,
        lessons: lessonsByCourse.get(String(course._id)) || [],
      })),
    },
  });
});

export const getStudentCourseContent = catchAsync(async (req, res, next) => {
  const student = await ensureStudent(req.user._id);
  const course = await Course.findById(req.params.courseId).lean();
  if (!course) return next(new AppError(404, "Course not found"));

  const lessons = await Lesson.find({
    course: course._id,
    gradeLevel: student.gradeLevel,
    status: "active",
  })
    .sort({ strand: 1, subStrand: 1, lessonNumber: 1 })
    .lean();

  const progress = await Progress.find({
    student: student._id,
    course: course._id,
  }).lean();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Course content fetched successfully",
    data: {
      course,
      lessons,
      progress,
    },
  });
});

export const saveStudentActivity = catchAsync(async (req, res, next) => {
  const student = await ensureStudent(req.user._id);
  const { lessonId, activityType, status, score, activityMinutes } = req.body;

  if (!lessonId || !activityType) {
    return next(new AppError(400, "lessonId and activityType are required"));
  }

  const lesson = await Lesson.findById(lessonId);
  if (!lesson) return next(new AppError(404, "Lesson not found"));

  const update = {
    status: status || "in_progress",
    activityMinutes: Number(activityMinutes || 0),
    performedAt: new Date(),
  };

  if (score !== undefined) {
    update.score = Number(score);
  }

  if (update.status === "completed") {
    update.completedAt = new Date();
  }

  const progress = await Progress.findOneAndUpdate(
    {
      student: student._id,
      lesson: lesson._id,
      activityType,
    },
    {
      $set: {
        ...update,
        course: lesson.course,
      },
      $setOnInsert: {
        student: student._id,
        lesson: lesson._id,
        activityType,
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
    },
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Activity saved successfully",
    data: progress,
  });
});

export const getStudentProgress = catchAsync(async (req, res) => {
  const student = await ensureStudent(req.user._id);
  const summary = await getSummary(student._id);

  const subjectProgress = await Progress.aggregate([
    { $match: { student: student._id } },
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
        totalHours: { $round: [{ $divide: ["$totalMinutes", 60] }, 2] },
        activityCount: "$totalActivities",
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

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Progress fetched successfully",
    data: {
      summary,
      subjectProgress,
    },
  });
});

export const getStudentSubjectProgress = catchAsync(async (req, res, next) => {
  const student = await ensureStudent(req.user._id);
  const { courseId } = req.params;
  const { period = "weekly" } = req.query;

  const timeFilter = buildTimelineFilter(period);
  const match = {
    student: student._id,
    course: courseId,
  };
  if (timeFilter) {
    match.performedAt = timeFilter;
  }

  const activities = await Progress.find(match)
    .populate("lesson", "title strand subStrand lessonNumber")
    .sort({ performedAt: -1 })
    .lean();

  if (!activities.length) {
    return next(new AppError(404, "No progress found for this subject"));
  }

  const summary = {
    totalActivities: activities.length,
    completedActivities: activities.filter(
      (item) => item.status === "completed",
    ).length,
    avgQuizScore:
      activities
        .filter((item) => item.activityType === "quiz" && item.score !== null)
        .reduce((acc, item) => acc + item.score, 0) /
      Math.max(
        activities.filter(
          (item) => item.activityType === "quiz" && item.score !== null,
        ).length,
        1,
      ),
  };

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Subject progress fetched successfully",
    data: {
      period,
      summary: {
        ...summary,
        avgQuizScore: Number((summary.avgQuizScore || 0).toFixed(2)),
      },
      activities,
    },
  });
});

export const getStudentProfile = catchAsync(async (req, res) => {
  const student = await ensureStudent(req.user._id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile fetched successfully",
    data: {
      student: {
        _id: student._id,
        name: student.name,
        userId: student.user?.userId,
        gradeLevel: student.gradeLevel,
        status: student.status,
        school: student.school,
        picture: student.picture,
        file: student.file,
      },
    },
  });
});

export const updateStudentProfile = catchAsync(async (req, res) => {
  const student = await ensureStudent(req.user._id);
  const user = await User.findById(req.user._id);

  if (req.body.name) {
    student.name = req.body.name;
    user.name = req.body.name;
  }

  // Upload profile image
  if (req.files?.picture?.[0]) {
    const upload = await uploadOnCloudinary(
      req.files.picture[0].buffer,
      "profiles",
    );
    student.picture = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  // Upload file
  if (req.files?.file?.[0]) {
    const upload = await uploadOnCloudinary(req.files.file[0].buffer, "files");
    student.file = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  await Promise.all([student.save(), user.save()]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile updated successfully",
    data: {
      student,
      user,
    },
  });
});

export const getStudentPrivacyPolicy = catchAsync(async (req, res) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Privacy policy fetched successfully",
    data: {
      title: "Privacy Policy",
      content:
        "Control who can see your progress. We use your learning activity, quiz, and profile data to provide personalized educational insights.",
    },
  });
});

export const createStudentSupportTicket = catchAsync(async (req, res, next) => {
  const { subject, description } = req.body;

  if (!subject || !description) {
    return next(new AppError(400, "subject and description are required"));
  }

  const ticket = await SupportTicket.create({
    user: req.user._id,
    role: "student",
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
