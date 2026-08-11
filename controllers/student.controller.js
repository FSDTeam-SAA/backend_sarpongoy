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
import { parsePagination, getPaginationMeta } from "../utils/pagination.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import mongoose from "mongoose";

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
  const {
    lessonId, activityType, subActivity, status, score, activityMinutes,
    originalScore, totalQuestions, practiceOriginalScore, quizOriginalScore
  } = req.body;

  if (!lessonId || !activityType) {
    return next(new AppError(400, "lessonId and activityType are required"));
  }

  const lesson = await Lesson.findById(lessonId);
  if (!lesson) return next(new AppError(404, "Lesson not found"));

  const parseScore = (val) => (val !== undefined && val !== null && val !== "") ? Number(val) : null;

  const update = {
    status: status || "in_progress",
    activityMinutes: Number(activityMinutes || 0),
    performedAt: new Date(),
    subActivity: subActivity || null,
    lessonId,
    lastUpdated: new Date(),
  };

  if (score !== undefined) update.score = parseScore(score);
  if (originalScore !== undefined) update.originalScore = parseScore(originalScore);
  if (totalQuestions !== undefined) update.totalQuestions = parseScore(totalQuestions);
  if (practiceOriginalScore !== undefined) update.practiceOriginalScore = parseScore(practiceOriginalScore);
  if (quizOriginalScore !== undefined) update.quizOriginalScore = parseScore(quizOriginalScore);

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
        strandName: lesson.strand,
        subStrandName: lesson.subStrand,
        lessonNumber: String(lesson.lessonNumber),
        gradeName: lesson.gradeLevel,
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

export const syncStudentActivities = catchAsync(async (req, res, next) => {
  const student = await ensureStudent(req.user._id);
  const activities = Array.isArray(req.body.progress_data)
    ? req.body.progress_data
    : [];

  console.log("Received activities for sync: ", activities);
  const topLevelGrade = req.body.grade_name || null;

  if (!activities.length) {
    return next(new AppError(400, "activities array is required"));
  }

  let saved = 0;
  let skipped = 0; // Tracks items ignored due to older timestamps
  const errors = [];

  // --- Step 1: Pre-fetch Existing Data to Solve N+1 Problem ---
  const validLessonIds = activities
    .map((i) => i.lesson_id || i.lessonId || i.lesson)
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const existingLessons = await Lesson.find({ _id: { $in: validLessonIds } }).lean();
  const lessonMap = new Map(existingLessons.map((l) => [String(l._id), l]));

  const courseNames = [...new Set(activities.map((i) => i.course_name).filter(Boolean))];
  const existingCourses = await Course.find({
    name: { $in: courseNames.map((n) => new RegExp(`^${n.trim()}$`, "i")) }
  }).lean();
  const courseMap = new Map(existingCourses.map((c) => [c.name.toLowerCase().trim(), c]));

  const existingProgress = await Progress.find({
    student: student._id,
    lesson: { $in: validLessonIds }
  }).lean();
  const progressMap = new Map(
    existingProgress.map((p) => [`${p.lesson}_${p.activityType}_${p.subActivity || null}`, p])
  );

  const bulkOps = [];

  // --- Step 2: Iterate and Build Bulk Operations ---
  for (let idx = 0; idx < activities.length; idx += 1) {
    const item = activities[idx] || {};
    const lessonId = item.lesson_id || item.lessonId || item.lesson;
    const activityType = String(item.activity_type || item.activityType || "").trim().toLowerCase();

    if (!lessonId || !activityType) {
      errors.push({ index: idx, reason: "lesson_id and activity_type are required" });
      continue;
    }

    let lessonDoc = mongoose.Types.ObjectId.isValid(lessonId) ? lessonMap.get(String(lessonId)) : null;
    let courseDoc = item.course_name ? courseMap.get(String(item.course_name).toLowerCase().trim()) : null;

    // Fallback: Create Course if perfectly missing
    if (item.course_name && !courseDoc) {
      const normalizedCourseName = String(item.course_name).trim();
      courseDoc = await Course.create({
        name: normalizedCourseName,
        gradeLevels: [normalizeGradeLevel(item.grade_name || topLevelGrade || student.gradeLevel)]
      });
      courseMap.set(normalizedCourseName.toLowerCase(), courseDoc);
    }

    // Fallback: Create/Find Lesson if missing
    if (!lessonDoc && courseDoc) {
      const lessonQuery = {
        course: courseDoc._id,
        gradeLevel: normalizeGradeLevel(item.grade_name || topLevelGrade || student.gradeLevel),
        strand: item.strand_name,
        subStrand: item.sub_strand_name,
      };
      if (item.lesson_number) {
        const parsed = parseInt(String(item.lesson_number).replace(/^\D+/g, ""), 10);
        lessonQuery.lessonNumber = !isNaN(parsed) ? parsed : item.lesson_number;
      }

      lessonDoc = await Lesson.findOne(lessonQuery);

      if (!lessonDoc) {
        const lessonTitle = (item.lesson_id && !mongoose.Types.ObjectId.isValid(item.lesson_id))
          ? item.lesson_id
          : (item.lesson_title || "Untitled Lesson");

        lessonDoc = await Lesson.create({
          course: courseDoc._id,
          gradeLevel: normalizeGradeLevel(item.grade_name || topLevelGrade || student.gradeLevel),
          strand: item.strand_name || "Unknown Strand",
          subStrand: item.sub_strand_name || "Unknown Sub-strand",
          lessonNumber: lessonQuery.lessonNumber || 1,
          title: lessonTitle,
          status: "active"
        });
      }
      lessonMap.set(String(lessonDoc._id), lessonDoc);
    }

    if (!lessonDoc) {
      errors.push({ index: idx, lessonId, reason: "Lesson not found in database. Matching failed." });
      continue;
    }

    if (!courseDoc) {
      courseDoc = await Course.findById(lessonDoc.course).lean();
    }

    const status = (Number(item.is_completed) === 1 || item.is_completed === true) ? "completed" : "in_progress";
    const incomingLastUpdated = item.last_updated ? new Date(item.last_updated) : new Date();

    // --- Step 3: Conflict Resolution (Last Write Wins) ---
    const progressKey = `${lessonDoc._id}_${activityType}_${item.sub_activity || null}`;
    const existingRecord = progressMap.get(progressKey);

    // If existing record is newer than incoming, skip this update
    if (existingRecord && new Date(existingRecord.lastUpdated) > incomingLastUpdated) {
      skipped += 1;
      continue;
    }

    const parseScore = (val) => (val !== undefined && val !== null && val !== "") ? Number(val) : null;

    const payload = {
      student: student._id,
      course: courseDoc?._id,
      courseName: item.course_name || courseDoc?.name || undefined,
      lesson: lessonDoc._id,
      lessonId: lessonId,
      strandName: item.strand_name || lessonDoc.strand,
      subStrandName: item.sub_strand_name || lessonDoc.subStrand,
      lessonNumber: item.lesson_number || String(lessonDoc.lessonNumber),
      gradeName: item.grade_name || lessonDoc.gradeLevel,
      activityType,
      subActivity: item.sub_activity || null,
      status,
      activityMinutes: Number(item.activity_minutes || 0),
      score: parseScore(item.score),
      originalScore: parseScore(item.original_score),
      totalQuestions: parseScore(item.total_questions),
      syncStatus: item.sync_status !== undefined ? Number(item.sync_status) : 1,
      lastUpdated: incomingLastUpdated,
      performedAt: incomingLastUpdated,
      practiceOriginalScore: parseScore(item.practice_original_score),
      quizOriginalScore: parseScore(item.quiz_original_score),
    };

    if (status === "completed") {
      payload.completedAt = incomingLastUpdated;
    }

    bulkOps.push({
      updateOne: {
        filter: {
          student: student._id,
          lesson: lessonDoc._id,
          activityType: payload.activityType,
          subActivity: payload.subActivity,
        },
        update: { $set: payload },
        upsert: true
      }
    });

    // Update in-memory map to resolve conflicts within the same request payload
    progressMap.set(progressKey, { lastUpdated: incomingLastUpdated });
  }

  // --- Step 4: Execute Bulk Write ---
  if (bulkOps.length > 0) {
    try {
      await Progress.bulkWrite(bulkOps, { ordered: false });
      saved = bulkOps.length;
    } catch (error) {
      console.error("BulkWrite error : ", error);
      if (error.writeErrors) {
        error.writeErrors.forEach(err => errors.push({ reason: err.errmsg }));
        saved = bulkOps.length - error.writeErrors.length;
      } else {
        errors.push({ reason: error.message });
      }
    }
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Activities synced successfully",
    data: {
      received: activities.length,
      saved,
      skipped,
      errors,
    },
  });
});

export const getStudentActivities = catchAsync(async (req, res) => {
  const student = await ensureStudent(req.user._id);
  const { page, limit, skip } = parsePagination(req.query);

  // Delta Sync Strategy
  const filter = { student: student._id };
  if (req.query.since) {
    const sinceDate = new Date(req.query.since);
    if (!isNaN(sinceDate.getTime())) {
      filter.lastUpdated = { $gt: sinceDate };
    }
  }

  const [items, total] = await Promise.all([
    Progress.find(filter)
      .populate("course", "name")
      .populate("lesson", "title strand subStrand lessonNumber")
      .sort({ lastUpdated: -1, performedAt: -1 }) // Sort by lastUpdated for proper sync ordering
      .skip(skip)
      //.limit(limit)
      .lean(),
    Progress.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Activities fetched successfully",
    data: {
      items,
      meta: getPaginationMeta({ page, limit, total }),
    },
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
        .filter((item) => item.activityType === "quiz")
        .reduce((acc, item) => acc + (item.score || 0), 0) /
      Math.max(
        activities.filter((item) => item.activityType === "quiz").length,
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
  const summary = await getSummary(student._id);

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
        averageScore: summary.avgQuizScore,
        totalNumberOfMinutes: summary.totalHours * 60,
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
