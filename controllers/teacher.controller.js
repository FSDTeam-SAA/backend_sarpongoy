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

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ACTIVE_LOGIN_WINDOW_DAYS = 30;

const normalizeFilterValue = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const isAllFilter = (value) => {
  const normalized = normalizeFilterValue(value);
  return !normalized || normalized === "all";
};

const getDateRangeFromPeriod = (period) => {
  const now = new Date();
  const normalized = normalizeFilterValue(period);
  const start = new Date(now);

  switch (normalized) {
    case "today":
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "day" };
    case "past week":
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "day" };
    case "past 1 month":
      start.setMonth(now.getMonth() - 1);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "day" };
    case "past 3 months":
      start.setMonth(now.getMonth() - 3);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "month" };
    case "past 6 months":
      start.setMonth(now.getMonth() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "month" };
    case "past year":
    default:
      start.setFullYear(now.getFullYear() - 1);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "month" };
  }
};

const normalizeSubjectName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ");

const matchesSubjectFilter = (courseName, subject) => {
  if (isAllFilter(subject)) return true;

  const normalizedSubject = normalizeSubjectName(subject);
  const normalizedCourse = normalizeSubjectName(courseName);

  const aliases = {
    english: ["english"],
    science: ["science"],
    math: ["math", "mathematics"],
    "religious and moral education": ["religious and moral education"],
    "social studies": ["social studies", "social science"],
    "social science": ["social studies", "social science"],
  };

  const subjectAliases = aliases[normalizedSubject] || [normalizedSubject];

  return subjectAliases.some(
    (alias) =>
      normalizedCourse === alias ||
      normalizedCourse.includes(alias) ||
      alias.includes(normalizedCourse),
  );
};

const resolveTeacherCourseIds = (teacherCourses = [], subject = "ALL") => {
  if (isAllFilter(subject)) {
    return teacherCourses.map((course) => course._id);
  }

  return teacherCourses
    .filter((course) => matchesSubjectFilter(course.name, subject))
    .map((course) => course._id);
};

const getGradeLevelFilter = (gradeLevel, fallback = "ALL") => {
  const normalized = normalizeGradeLevel(gradeLevel || fallback);
  return isAllFilter(normalized) ? null : normalized;
};

const getOverviewGradeLevel = (gradeLevel) => {
  const normalized = normalizeGradeLevel(gradeLevel);
  return isAllFilter(normalized) ? null : normalized;
};

const buildStudentProgressMatch = ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range = null,
}) => {
  const match = { student: studentId };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  const normalizedGradeLevel = getOverviewGradeLevel(gradeLevel);
  if (normalizedGradeLevel) {
    match.gradeName = normalizedGradeLevel;
  }

  if (range) {
    match.performedAt = { $gte: range.start, $lte: range.end };
  }

  return match;
};

const getStudentLoginStatus = (lastLoginAt) => {
  if (!lastLoginAt) return "inactive";

  const lastLoginTime = new Date(lastLoginAt).getTime();
  if (Number.isNaN(lastLoginTime)) return "inactive";

  return Date.now() - lastLoginTime <= ACTIVE_LOGIN_WINDOW_DAYS * DAY_IN_MS
    ? "active"
    : "inactive";
};

const buildDateRangeMatch = (range) =>
  range ? { performedAt: { $gte: range.start, $lte: range.end } } : {};

const buildSeriesBuckets = (range) => {
  if (!range) return [];

  const buckets = [];
  const cursor = new Date(range.start);
  cursor.setHours(0, 0, 0, 0);

  if (range.key === "day") {
    while (cursor <= range.end) {
      const key = cursor.toISOString().slice(0, 10);
      buckets.push({
        key,
        label: cursor.toLocaleDateString("en-US", { weekday: "short" }),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return buckets;
  }

  cursor.setDate(1);
  while (cursor <= range.end) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    buckets.push({
      key,
      label: cursor.toLocaleDateString("en-US", { month: "short" }),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return buckets;
};

const mapBucketKey = (date, keyType) => {
  const current = new Date(date);
  if (keyType === "day") {
    return current.toISOString().slice(0, 10);
  }
  return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;
};

const buildPeriodSeries = (raw, range) => {
  const buckets = buildSeriesBuckets(range);
  if (!buckets.length) return [];

  return buckets.map((bucket) => {
    const found = raw.find((item) => item.bucket === bucket.key);
    return {
      label: bucket.label,
      key: bucket.key,
      total: found?.total || 0,
      avgQuizScore: found?.avgQuizScore || 0,
    };
  });
};

const buildStudentStatusCounts = (students = []) =>
  students.reduce(
    (acc, student) => {
      const status = getStudentLoginStatus(student.user?.lastLoginAt);
      acc[status] += 1;
      return acc;
    },
    { active: 0, inactive: 0 },
  );

const getRangeDays = (range) => {
  if (!range?.start || !range?.end) return null;
  const diff = Math.ceil(
    (new Date(range.end).getTime() - new Date(range.start).getTime()) /
      DAY_IN_MS,
  );
  return Math.max(diff + 1, 1);
};

const getStudentProgressSummary = async ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range = null,
}) => {
  const match = buildStudentProgressMatch({
    studentId,
    courseIds,
    gradeLevel,
    range,
  });

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
      activityCount: summary?.totalActivities || 0,
      totalHours: Number(((summary?.totalMinutes || 0) / 60 || 0).toFixed(2)),
      avgDailyHours: Number(
        (
          (summary?.totalMinutes || 0) /
          60 /
          (getRangeDays(range) || 1)
        ).toFixed(2),
      ),
      avgQuizScore: Number((summary?.avgQuizScore || 0).toFixed(2)),
    },
    subjectProgress: bySubject,
  };
};

const getCourseWiseOverview = async ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range = null,
}) => {
  const match = buildStudentProgressMatch({
    studentId,
    courseIds,
    gradeLevel,
    range,
  });

  const rawData = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          course: "$course",
          day: { $dateToString: { format: "%Y-%m-%d", date: "$performedAt" } },
        },
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
        localField: "_id.course",
        foreignField: "_id",
        as: "courseData",
      },
    },
    { $unwind: "$courseData" },
    {
      $project: {
        _id: 0,
        courseId: "$course._id",
        subject: "$course.name",
        avgDailyHours: {
          $round: [{ $divide: [{ $divide: ["$totalMinutes", 60] }, 7] }, 2],
        },
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
  ]);

  // Group by course and format weekly marks
  const courseMap = {};
  rawData.forEach((item) => {
    const cid = item.courseId.toString();
    if (!courseMap[cid]) {
      courseMap[cid] = {
        courseId: item.courseId,
        subject: item.subject,
        rawRecords: [],
      };
    }
    courseMap[cid].rawRecords.push({
      date: item.date,
      activityCount: item.activityCount,
      totalHours: Number((item.totalMinutes / 60).toFixed(2)),
      avgQuizScore: item.avgQuizScore,
    });
  });

  const result = Object.values(courseMap).map((course) => {
    const marks = formatWeeklySeries(course.rawRecords, now, course.subject);
    return {
      courseId: course.courseId,
      subject: course.subject,
      activityCount: marks.totals.activityCount,
      totalHours: marks.totals.totalHours,
      avgDailyHours: marks.totals.avgDailyHours,
      avgQuizScore: marks.totals.avgQuizScore,
      completionRate: 0, // Will recalculate below
      marks,
    };
  });

  // Calculate completionRate accurately per course
  // We need total and completed activities for the period
  for (const course of result) {
    const courseMatch = { ...match, course: course.courseId };
    const [summary] = await Progress.aggregate([
      { $match: courseMatch },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } }
        }
      }
    ]);
    if (summary) {
      course.completionRate = summary.total > 0 ? Number(((summary.completed / summary.total) * 100).toFixed(2)) : 0;
    }
  }

  return result.sort((a, b) => a.subject.localeCompare(b.subject));
};

const formatWeeklySeries = (rawRecords, now = new Date(), subjectName = null) => {
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const dateObj = new Date(now);
    dateObj.setDate(now.getDate() - i);
    const iso = dateObj.toISOString().slice(0, 10);
    const found = rawRecords.find((item) => item.date === iso);
    days.push({
      label: dayLabels[dateObj.getDay()],
      subject: subjectName,
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

const buildWeeklyActivitySeries = async (match, subjectName = "Overall") => {
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
        avgDailyHours: { $round: [{ $divide: ["$totalMinutes", 60] }, 2] },
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
      avgDailyHours: found?.avgDailyHours || 0,
      avgQuizScore: found?.avgQuizScore || 0,
    });
  }

  const totals = days.reduce(
    (acc, cur) => ({
      avgDailyHoursSum: Number(
        (acc.avgDailyHoursSum + cur.avgDailyHours).toFixed(2),
      ),
      avgQuizScoreSum:
        acc.avgQuizScoreSum + (Number(cur.avgQuizScore) || 0) / days.length,
    }),
    { avgDailyHoursSum: 0, avgQuizScoreSum: 0 },
  );

  return {
    days,
    totals: {
      avgQuizScore: Number(totals.avgQuizScoreSum.toFixed(2)),
      avgDailyHours: Number((totals.avgDailyHoursSum / days.length).toFixed(2)),
    },
  };
};

const getMonthlyCompletionByCourse = async (studentIds, courseIds, filterCourseId = null) => {
  if (!courseIds.length) return [];
  const targetCourseIds = filterCourseId ? [filterCourseId] : courseIds;

  const docs = await Progress.aggregate([
    {
      $match: {
        status: "completed",
        student: { $in: studentIds },
        course: { $in: targetCourseIds.map(id => new mongoose.Types.ObjectId(id)) },
      },
    },
    {
      $group: {
        _id: {
          course: "$course",
          year: { $year: "$performedAt" },
          month: { $month: "$performedAt" },
        },
        completed: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: "courses",
        localField: "_id.course",
        foreignField: "_id",
        as: "courseData",
      },
    },
    { $unwind: "$courseData" },
    {
      $project: {
        _id: 0,
        subject: "$courseData.name",
        year: "$_id.year",
        month: "$_id.month",
        completed: 1,
      },
    },
  ]);

  const monthMap = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const currentYear = new Date().getFullYear();
  
  const coursesDB = await Course.find({ _id: { $in: targetCourseIds } }).select("name").lean();

  const fullYearData = monthMap.map((label, idx) => {
    const monthIndex = idx + 1;
    const monthResult = { month: label };

    coursesDB.forEach(course => {
      const found = docs.find(d => d.subject === course.name && d.month === monthIndex && d.year === currentYear);
      monthResult[course.name] = found ? found.completed : 0;
    });

    return monthResult;
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
            practiceOriginalScore: "$practiceOriginalScore",
            quizOriginalScore: "$quizOriginalScore",
            total: "$totalQuestions",
            performedAt: "$performedAt",
            percentage: {
              $cond: [
                { $and: [{ $gt: ["$totalQuestions", 0] }, { $ne: ["$score", null] }] },
                { $multiply: [{ $divide: ["$score", "$totalQuestions"] }, 100] },
                0,
              ],
            },
            practiceOrigPercentage: {
              $cond: [
                { $and: [{ $gt: ["$totalQuestions", 0] }, { $ne: ["$practiceOriginalScore", null] }] },
                { $multiply: [{ $divide: ["$practiceOriginalScore", "$totalQuestions"] }, 100] },
                0,
              ],
            },
            quizOrigPercentage: {
              $cond: [
                { $and: [{ $gt: ["$totalQuestions", 0] }, { $ne: ["$quizOriginalScore", null] }] },
                { $multiply: [{ $divide: ["$quizOriginalScore", "$totalQuestions"] }, 100] },
                0,
              ],
            },
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
                cond: { $or: [{ $eq: ["$$a.type", "practice"] }, { $eq: ["$$a.type", "independent"] }] },
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
              $and: [{ $eq: ["$$a.type", "quiz"] }, { $ne: ["$$a.score", null] }, { $gt: ["$$a.total", 0] }],
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
        subject: "$course.name",
        practice: { $round: [{ $ifNull: ["$practice.percentage", 0] }, 1] },
        quiz: { $round: [{ $ifNull: ["$quiz.percentage", 0] }, 1] },
        "practice original Score": { $round: [{ $ifNull: ["$practice.practiceOrigPercentage", 0] }, 1] },
        "quiz original score": { $round: [{ $ifNull: ["$quiz.quizOrigPercentage", 0] }, 1] },
        "lowest quiz score": {
          $round: [
            {
              $ifNull: [{ $min: "$quizzes.percentage" }, 0],
            },
            1,
          ],
        },
        practiceDate: "$practice.performedAt",
        quizDate: "$quiz.performedAt",
      },
    },
    { $sort: { subject: 1 } },
  ]);
};

const getCompletionTrend = async ({
  studentIds = [],
  courseIds = [],
  range,
}) => {
  if (!studentIds.length) return [];

  const match = {
    student: { $in: studentIds },
    status: "completed",
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  if (range) {
    match.performedAt = { $gte: range.start, $lte: range.end };
  }

  const bucketFormat = range?.key === "day" ? "%Y-%m-%d" : "%Y-%m";

  const raw = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          bucket: {
            $dateToString: { format: bucketFormat, date: "$performedAt" },
          },
        },
        total: { $sum: 1 },
        totalMinutes: { $sum: "$activityMinutes" },
        avgQuizScore: {
          $avg: {
            $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        bucket: "$_id.bucket",
        total: 1,
        totalMinutes: 1,
        avgQuizScore: { $round: ["$avgQuizScore", 2] },
      },
    },
    { $sort: { bucket: 1 } },
  ]);

  return buildPeriodSeries(raw, range).map((item) => ({
    ...item,
    avgQuizScore: Number(item.avgQuizScore || 0),
  }));
};

const getSubjectPerformanceSeries = async ({
  studentIds = [],
  courseIds = [],
  range,
}) => {
  if (!studentIds.length) return [];

  const match = {
    student: { $in: studentIds },
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  if (range) {
    match.performedAt = { $gte: range.start, $lte: range.end };
  }

  const rangeDays = range
    ? Math.max(
        Math.ceil((range.end.getTime() - range.start.getTime()) / DAY_IN_MS),
        1,
      )
    : 7;

  const raw = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$course",
        totalMinutes: { $sum: "$activityMinutes" },
        avgQuizScore: {
          $avg: {
            $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null],
          },
        },
        totalActivities: { $sum: 1 },
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
        totalMinutes: 1,
        totalActivities: 1,
        avgQuizScore: { $round: ["$avgQuizScore", 2] },
      },
    },
    { $sort: { subject: 1 } },
  ]);

  return raw.map((item) => ({
    subject: item.subject,
    avgDailyHours: Number(
      ((item.totalMinutes || 0) / 60 / rangeDays).toFixed(2),
    ),
    avgQuizScore: Number(item.avgQuizScore || 0),
  }));
};

const getWeeklyActivityTrend = async ({ studentIds = [], courseIds = [] }) => {
  if (!studentIds.length) return [];

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - 6);
  startDate.setHours(0, 0, 0, 0);

  const match = {
    student: { $in: studentIds },
    status: "completed",
    performedAt: { $gte: startDate, $lte: now },
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  const raw = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$performedAt" } },
        },
        total: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        day: "$_id.day",
        total: 1,
      },
    },
    { $sort: { day: 1 } },
  ]);

  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const dateObj = new Date(now);
    dateObj.setDate(now.getDate() - i);
    const iso = dateObj.toISOString().slice(0, 10);
    const found = raw.find((item) => item.day === iso);
    days.push({
      label: dayLabels[dateObj.getDay()],
      date: iso,
      total: found?.total || 0,
    });
  }

  return days;
};

const getMonthlyActivityTrend = async ({
  studentIds = [],
  courseIds = [],
  gradeLevel = null,
}) => {
  if (!studentIds.length) return [];

  const now = new Date();
  const startDate = new Date(now.getFullYear(), 0, 1);
  const match = {
    student: { $in: studentIds },
    performedAt: { $gte: startDate, $lte: now },
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  const normalizedGradeLevel = getOverviewGradeLevel(gradeLevel);
  if (normalizedGradeLevel) {
    match.gradeName = normalizedGradeLevel;
  }

  const raw = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          month: { $dateToString: { format: "%Y-%m", date: "$performedAt" } },
        },
        totalMinutes: { $sum: "$activityMinutes" },
        avgQuizScore: {
          $avg: { $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        bucket: "$_id.month",
        totalMinutes: 1,
        avgQuizScore: { $round: ["$avgQuizScore", 2] },
      },
    },
    { $sort: { bucket: 1 } },
  ]);

  const monthLabels = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const monthDate = new Date(now.getFullYear(), i, 1);
    const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
    const found = raw.find((item) => item.bucket === key);
    months.push({
      label: monthLabels[monthDate.getMonth()],
      key,
      avgDailyHours: Number(
        (
          (found?.totalMinutes || 0) /
          60 /
          Math.max(new Date(now.getFullYear(), i + 1, 0).getDate(), 1)
        ).toFixed(2),
      ),
      avgQuizScore: Number(found?.avgQuizScore || 0),
    });
  }

  return {
    months,
    totals: {
      avgDailyHours: Number(
        (
          months.reduce(
            (acc, item) => acc + Number(item.avgDailyHours || 0),
            0,
          ) / Math.max(months.length, 1)
        ).toFixed(2),
      ),
      avgQuizScore: Number(
        (
          months.reduce(
            (acc, item) => acc + Number(item.avgQuizScore || 0),
            0,
          ) / Math.max(months.length, 1)
        ).toFixed(2),
      ),
    },
  };
};

const getTeacherRecentWork = async ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range,
  limit = 10,
}) => {
  if (!studentId) return [];

  const match = buildStudentProgressMatch({
    studentId,
    courseIds,
    gradeLevel,
    range,
  });

  const raw = await Progress.aggregate([
    { $match: match },
    {
      $sort: {
        performedAt: -1,
        updatedAt: -1,
        createdAt: -1,
        _id: -1,
      },
    },
    {
      $group: {
        _id: "$course",
        lessonId: { $first: "$lesson" },
        courseName: { $first: "$courseName" },
        performedAt: { $first: "$performedAt" },
        activityType: { $first: "$activityType" },
        score: { $first: "$score" },
        originalScore: { $first: "$originalScore" },
        strandName: { $first: "$strandName" },
        subStrandName: { $first: "$subStrandName" },
        lessonNumber: { $first: "$lessonNumber" },
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
    {
      $unwind: {
        path: "$course",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: "lessons",
        localField: "lessonId",
        foreignField: "_id",
        as: "lessonDoc",
      },
    },
    {
      $unwind: {
        path: "$lessonDoc",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        _id: 0,
        subject: { $ifNull: ["$course.name", "$courseName"] },
        date: "$performedAt",
        activityType: 1,
        score: 1,
        originalScore: 1,
        lesson: {
          strand: { $ifNull: ["$lessonDoc.strand", "$strandName"] },
          subStrand: {
            $ifNull: ["$lessonDoc.subStrand", "$subStrandName"],
          },
          lessonNumber: {
            $ifNull: ["$lessonDoc.lessonNumber", "$lessonNumber"],
          },
          title: { $ifNull: ["$lessonDoc.title", null] },
        },
      },
    },
    {
      $project: {
        subject: 1,
        date: 1,
        activityType: 1,
        score: 1,
        originalScore: 1,
        lesson: 1,
        practiceScore: {
          $cond: [{ $eq: ["$activityType", "practice"] }, "$score", null],
        },
        quizScore: {
          $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null],
        },
      },
    },
    { $sort: { date: -1 } },
    { $limit: limit },
  ]);

  return raw.map((item) => ({
    subject: item.subject,
    date: item.date,
    activityType: item.activityType,
    score:
      item.score === null || item.score === undefined ? null : Number(item.score),
    practiceScore:
      item.practiceScore === null || item.practiceScore === undefined
        ? null
        : Number(item.practiceScore),
    quizScore:
      item.quizScore === null || item.quizScore === undefined
        ? null
        : Number(item.quizScore),
    lesson: item.lesson,
  }));
};

export const getTeacherDashboard = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const gradeLevel = req.query.gradeLevel || "ALL";
  const timePeriod = req.query.timePeriod || "Past Year";
  const subject = req.query.subject || "ALL";

  const studentFilter = { school: teacher.school?._id };
  const normalizedGradeLevel = getGradeLevelFilter(gradeLevel);
  if (normalizedGradeLevel) {
    studentFilter.gradeLevel = normalizedGradeLevel;
  }

  const [students, courseIds] = await Promise.all([
    Student.find(studentFilter).populate("user", "userId lastLoginAt").lean(),
    Promise.resolve(resolveTeacherCourseIds(teacher.courses || [], subject)),
  ]);
  const selectedCourseIds =
    isAllFilter(subject) || courseIds.length ? courseIds : ["__no_match__"];

  const studentIds = students.map((student) => student._id);
  const loginCounts = buildStudentStatusCounts(students);
  const dateRange = getDateRangeFromPeriod(timePeriod);
  const progressMatch = {
    student: { $in: studentIds },
    ...(selectedCourseIds.length ? { course: { $in: selectedCourseIds } } : {}),
    ...buildDateRangeMatch(dateRange),
    status: "completed",
  };

  const allCourses = await Course.find({ status: "active" }).select("_id").lean();
  const courseIds = allCourses.map((c) => c._id);

  if (courseId) {
    progressMatch.course = courseId;
  }

  const now = new Date();
  const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const baseProgressMatch = { student: { $in: studentIds } };
  if (courseId) {
    baseProgressMatch.course = new mongoose.Types.ObjectId(courseId);
  }

  const [
    totalCompleted,
    prevMonthCompleted,
    totalQuizCompleted,
    prevMonthQuizCompleted,
    subjectOverview,
    subjectMetrics,
    weeklyStudents,
  ] = await Promise.all([
    Progress.countDocuments(progressMatch),
    Progress.countDocuments({ ...progressMatch, performedAt: { $lt: startOfCurrentMonth, $gte: startOfPrevMonth } }),
    Progress.countDocuments({ ...progressMatch, activityType: "quiz" }),
    getCompletionTrend({
      studentIds,
      courseIds: selectedCourseIds,
      range: dateRange,
    }),
    getSubjectPerformanceSeries({
      studentIds,
      courseIds: selectedCourseIds,
      range: dateRange,
    }),
    getWeeklyActivityTrend({ studentIds, courseIds: selectedCourseIds }),
  ]);

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
      filters: {
        gradeLevel,
        timePeriod,
        subject,
        gradeLevels: ["JHS1", "JHS2", "JHS3", "ALL"],
        timePeriods: [
          "Today",
          "Past Week",
          "Past 1 Month",
          "Past 3 Months",
          "Past 6 Months",
          "Past Year",
        ],
        subjects: [
          "English",
          "Science",
          "Social Science",
          "Religious and Moral Education",
          "Math",
          "ALL",
        ],
      },
      counters: {
        totalStudents: students.length,
        activeStudents: loginCounts.active,
        inactiveStudents: loginCounts.inactive,
        totalSubjects: teacher.courses?.length || 0,
        lessonCompleted: totalCompleted,
        lessonCompletedGrowth: calculateGrowth(currentMonthCompleted, prevMonthCompleted),
        quizCompleted: totalQuizCompleted,
        quizCompletedGrowth: calculateGrowth(currentMonthQuizCompleted, prevMonthQuizCompleted),
      },
      charts: {
        subjectOverview,
        subjectMetrics,
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
  const gradeLevel = req.query.gradeLevel || "ALL";

  if (req.query.status) filter.status = req.query.status;
  const normalizedGradeLevel = getGradeLevelFilter(gradeLevel);
  if (normalizedGradeLevel) filter.gradeLevel = normalizedGradeLevel;

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
      .populate("user", "userId lastLoginAt")
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
        status: getStudentLoginStatus(item.user?.lastLoginAt),
        lastLoginAt: item.user?.lastLoginAt || null,
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
    .populate("user", "name userId lastLoginAt")
    .lean();

  if (!student) return next(new AppError(404, "Student not found"));

  const progressSheet = await getStudentProgressSummary({
    studentId: student._id,
    gradeLevel: student.gradeLevel,
  });

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
        status: getStudentLoginStatus(student.user?.lastLoginAt),
        lastLoginAt: student.user?.lastLoginAt || null,
      },
      progressSheet,
    },
  });
});

export const getTeacherStudentOverview = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const gradeLevel = req.query.gradeLevel || "ALL";
  const subject = req.query.subject || "ALL";
  const timePeriod = req.query.timePeriod || "Today";
  const { courseId } = req.query;
  const allowedCourseIds = resolveTeacherCourseIds(
    teacher.courses || [],
    subject,
  );

  let selectedCourseIds = allowedCourseIds;
  if (courseId) {
    const hasCourse = await Course.exists({ _id: courseId, status: "active" });
    if (!hasCourse) {
      return next(new AppError(404, "Course not found or inactive"));
    }
    selectedCourseIds = [courseId];
  }

  const student = await Student.findOne({
    _id: req.params.studentId,
    school: teacher.school?._id,
  })
    .populate("school", "name schoolCode")
    .populate("user", "name userId status lastLoginAt")
    .lean();

  if (!student) return next(new AppError(404, "Student not found"));

  const recentRange = getDateRangeFromPeriod(timePeriod);
  const effectiveGradeLevel =
    getOverviewGradeLevel(gradeLevel) || student.gradeLevel;
  const matchBase = buildStudentProgressMatch({
    studentId: student._id,
    courseIds: selectedCourseIds,
    gradeLevel: effectiveGradeLevel,
    range: recentRange,
  });

  const [
    progressSheet,
    courseWiseOverview,
    monthlyActivity,
    recentWork,
    activityBreakdown,
  ] = await Promise.all([
    getStudentProgressSummary({
      studentId: student._id,
      courseIds: selectedCourseIds,
      gradeLevel: effectiveGradeLevel,
      range: recentRange,
    }),
    getCourseWiseOverview({
      studentId: student._id,
      courseIds: selectedCourseIds,
      gradeLevel: effectiveGradeLevel,
      range: recentRange,
    }),
    getMonthlyActivityTrend({
      studentIds: [student._id],
      courseIds: selectedCourseIds,
      gradeLevel: effectiveGradeLevel,
    }),
    getTeacherRecentWork({
      studentId: student._id,
      courseIds: selectedCourseIds,
      gradeLevel: effectiveGradeLevel,
      range: null,
    }),
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
        status: getStudentLoginStatus(student.user?.lastLoginAt),
        lastLoginAt: student.user?.lastLoginAt || null,
        picture: student.picture,
      },
      filters: {
        gradeLevel,
        timePeriod,
        subject,
        gradeLevels: ["JHS1", "JHS2", "JHS3", "ALL"],
        timePeriods: [
          "Today",
          "Past Week",
          "Past 1 Month",
          "Past 3 Months",
          "Past 6 Months",
          "Past Year",
        ],
        subjects: [
          "English",
          "Science",
          "Social Science",
          "Religious and Moral Education",
          "Math",
          "ALL",
        ],
      },
      overview: {
        summary: progressSheet.summary,
        subjectProgress: progressSheet.subjectProgress,
        courseWiseOverview,
        monthlyActivity,
        activityBreakdown,
        recentWork,
      },
      recentWork: recentWorkMap,
      subjectWise: subjectWiseMap,
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
