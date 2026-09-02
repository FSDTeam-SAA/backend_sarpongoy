import bcrypt from "bcryptjs";
import AppError from "../errors/AppError.js";
import { Course } from "../models/course.model.js";
import { Lesson } from "../models/lesson.model.js";
import { Progress } from "../models/progress.model.js";
import { School } from "../models/school.model.js";
import { Student } from "../models/student.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";
import { Teacher } from "../models/teacher.model.js";
import { User } from "../models/user.model.js";
import { GRADE_LEVELS, normalizeGradeLevel } from "../utils/grade.js";
import { parsePagination, getPaginationMeta } from "../utils/pagination.js";
import { DEFAULT_SECURITY_QUESTIONS } from "../utils/securityQuestions.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import mongoose from "mongoose";

const buildSearchRegex = (value) =>
  new RegExp(
    String(value)
      .trim()
      .replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"),
    "i",
  );

const normalizeUserId = (userId) =>
  String(userId || "")
    .trim()
    .toUpperCase();

const splitNameParts = (value) => {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return { firstName: "", lastName: "" };
  }

  if (parts.length === 1) {
    return { firstName: parts[0], lastName: parts[0] };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
};

const syncSchoolCounts = async (schoolId) => {
  const [totalStudent, totalTeacher] = await Promise.all([
    Student.countDocuments({ school: schoolId }),
    Teacher.countDocuments({ school: schoolId }),
  ]);

  await School.findByIdAndUpdate(schoolId, { totalStudent, totalTeacher });
};

const parseSecurityQuestions = async (body) => {
  if (
    Array.isArray(body.securityQuestions) &&
    body.securityQuestions.length > 0
  ) {
    const parsed = [];
    for (const item of body.securityQuestions) {
      if (!item?.question || !item?.answer) continue;
      const answerHash = await bcrypt.hash(
        String(item.answer).trim().toLowerCase(),
        10,
      );
      parsed.push({ question: String(item.question).trim(), answerHash });
    }
    return parsed;
  }

  if (body.securityAnswers && typeof body.securityAnswers === "object") {
    const parsed = [];
    for (const question of DEFAULT_SECURITY_QUESTIONS) {
      const answer = body.securityAnswers[question];
      if (!answer) continue;
      const answerHash = await bcrypt.hash(
        String(answer).trim().toLowerCase(),
        10,
      );
      parsed.push({ question, answerHash });
    }
    return parsed;
  }

  return [];
};

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
        quizScoreTotal: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$activityType", "quiz"] },
                  { $ne: ["$score", null] },
                  { $gt: ["$totalQuestions", 0] },
                ],
              },
              { $multiply: [{ $divide: ["$score", "$totalQuestions"] }, 100] },
              0,
            ],
          },
        },
        quizCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$activityType", "quiz"] },
                  { $ne: ["$score", null] },
                  { $gt: ["$totalQuestions", 0] },
                ],
              },
              1,
              0,
            ],
          },
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
        totalMinutes: { $sum: "$activityMinutes" },
        quizScoreTotal: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$activityType", "quiz"] },
                  { $ne: ["$score", null] },
                  { $gt: ["$totalQuestions", 0] },
                ],
              },
              { $multiply: [{ $divide: ["$score", "$totalQuestions"] }, 100] },
              0,
            ],
          },
        },
        quizCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$activityType", "quiz"] },
                  { $ne: ["$score", null] },
                  { $gt: ["$totalQuestions", 0] },
                ],
              },
              1,
              0,
            ],
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
        totalActivities: "$total",
        completedActivities: "$completed",
        totalHours: {
          $round: [{ $divide: ["$totalMinutes", 60] }, 2],
        },
        avgQuizScore: {
          $round: [
            {
              $cond: [
                { $gt: ["$quizCount", 0] },
                { $divide: ["$quizScoreTotal", "$quizCount"] },
                0,
              ],
            },
            2,
          ],
        },
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

  const recentWork = await Progress.find({ student: studentId })
    .populate("course", "name")
    .populate("lesson", "title strand subStrand")
    .sort({ updatedAt: -1 })
    .limit(40)
    .lean();

  const lowestQuizScores = await Progress.find({
    student: studentId,
    activityType: "quiz",
    score: { $ne: null },
  })
    .populate("course", "name")
    .sort({ score: 1 })
    .limit(5)
    .lean();

  return {
    summary: {
      totalActivities: summary?.totalActivities || 0,
      completedActivities: summary?.completedActivities || 0,
      totalHours: Number(((summary?.totalMinutes || 0) / 60 || 0).toFixed(2)),
      avgQuizScore: Number(
        ((summary?.quizCount || 0) > 0
          ? summary.quizScoreTotal / summary.quizCount
          : 0
        ).toFixed(2),
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
    recentWork: recentWork.map((item) => ({
      _id: item._id,
      subject: item.course?.name || "",
      lessonTitle: item.lesson?.title || "",
      strand: item.lesson?.strand || "",
      subStrand: item.lesson?.subStrand || "",
      activityType: item.activityType,
      status: item.status,
      score: item.score,
      updatedAt: item.updatedAt,
    })),
    lowestQuizScores: lowestQuizScores.map((item) => ({
      _id: item._id,
      subject: item.course?.name || "",
      score: item.score,
      updatedAt: item.updatedAt,
    })),
  };
};

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const getPastYearRange = () => {
  const now = new Date();
  const start = new Date(now);
  start.setFullYear(now.getFullYear() - 1);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return { start, end: now };
};

const buildMonthlyBuckets = ({ start, end }) => {
  const buckets = [];
  const cursor = new Date(start);
  cursor.setDate(1);
  while (cursor <= end) {
    buckets.push({
      key: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`,
      label: cursor.toLocaleDateString("en-US", { month: "short" }),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return buckets;
};

const getTeacherCompletionTrend = async ({ studentIds, courseIds, range }) => {
  const buckets = buildMonthlyBuckets(range);

  if (!studentIds.length) {
    return buckets.map((bucket) => ({
      month: bucket.label,
      completed: 0,
      avgQuizScore: 0,
    }));
  }

  const match = {
    student: { $in: studentIds },
    lastUpdated: { $gte: range.start, $lte: range.end },
  };
  if (courseIds.length) match.course = { $in: courseIds };

  const raw = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$lastUpdated" } },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
        avgQuizScore: {
          $avg: { $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null] },
        },
      },
    },
  ]);

  const byKey = new Map(raw.map((item) => [item._id, item]));

  return buckets.map((bucket) => {
    const found = byKey.get(bucket.key);
    return {
      month: bucket.label,
      completed: found?.completed || 0,
      avgQuizScore: Number((found?.avgQuizScore || 0).toFixed(1)),
    };
  });
};

const getTeacherCoursePerformance = async ({ studentIds, courseIds }) => {
  if (!studentIds.length || !courseIds.length) return [];

  return Progress.aggregate([
    { $match: { student: { $in: studentIds }, course: { $in: courseIds } } },
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
        courseId: "$course._id",
        subject: "$course.name",
        completionRate: {
          $cond: [
            { $eq: ["$total", 0] },
            0,
            {
              $round: [
                { $multiply: [{ $divide: ["$completed", "$total"] }, 100] },
                0,
              ],
            },
          ],
        },
      },
    },
  ]);
};

const getTeacherRecentWork = async ({ studentIds, courseIds }) => {
  if (!studentIds.length || !courseIds.length) return [];

  const [practice, quiz, courses] = await Promise.all([
    Progress.aggregate([
      {
        $match: {
          student: { $in: studentIds },
          course: { $in: courseIds },
          activityType: "independent",
        },
      },
      {
        $group: {
          _id: "$course",
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          total: { $sum: 1 },
        },
      },
    ]),
    Progress.aggregate([
      {
        $match: {
          student: { $in: studentIds },
          course: { $in: courseIds },
          activityType: "quiz",
        },
      },
      {
        $group: {
          _id: "$course",
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          total: { $sum: 1 },
          lowestScorePct: {
            $min: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$score", null] },
                    { $gt: ["$totalQuestions", 0] },
                  ],
                },
                { $multiply: [{ $divide: ["$score", "$totalQuestions"] }, 100] },
                null,
              ],
            },
          },
        },
      },
    ]),
    Course.find({ _id: { $in: courseIds } })
      .select("name")
      .lean(),
  ]);

  const practiceMap = new Map(practice.map((item) => [String(item._id), item]));
  const quizMap = new Map(quiz.map((item) => [String(item._id), item]));

  return courses.map((course) => {
    const p = practiceMap.get(String(course._id));
    const q = quizMap.get(String(course._id));
    return {
      subject: course.name,
      practiceCompleted: p?.completed || 0,
      practiceTotal: p?.total || 0,
      quizCompleted: q?.completed || 0,
      quizTotal: q?.total || 0,
      lowestQuizScore:
        q?.lowestScorePct != null ? Math.round(q.lowestScorePct) : null,
    };
  });
};

const ensureSchool = async ({ schoolId, schoolName }) => {
  if (schoolId && mongoose.Types.ObjectId.isValid(schoolId)) {
    return School.findById(schoolId);
  }
  if (schoolName) return School.findOne({ name: schoolName });
  return null;
};

const ensureGrade = (gradeLevel) => {
  const normalized = normalizeGradeLevel(gradeLevel);
  if (!GRADE_LEVELS.includes(normalized)) {
    throw new AppError(400, "Invalid grade level");
  }
  return normalized;
};

const parseBulkRecordIds = (value, recordLabel) => {
  if (!Array.isArray(value)) {
    throw new AppError(400, `${recordLabel} IDs must be an array`);
  }

  const ids = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new AppError(400, `Select at least one ${recordLabel.toLowerCase()}`);
  }
  if (ids.length > 500) {
    throw new AppError(400, `A maximum of 500 ${recordLabel.toLowerCase()}s can be updated`);
  }
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new AppError(400, `Some ${recordLabel.toLowerCase()} IDs are invalid`);
  }

  return ids;
};

const updatePeopleGradeLevel = async ({ Model, ids, gradeLevel, recordLabel }) => {
  const records = await Model.find({ _id: { $in: ids } }).select("_id user").lean();
  if (records.length !== ids.length) {
    throw new AppError(404, `Some selected ${recordLabel.toLowerCase()}s were not found`);
  }

  const userIds = records.map((record) => record.user).filter(Boolean);
  await Promise.all([
    Model.updateMany({ _id: { $in: ids } }, { $set: { gradeLevel } }),
    User.updateMany({ _id: { $in: userIds } }, { $set: { gradeLevel } }),
  ]);

  return records.length;
};

const parseArrayField = (value) => {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [value];
};

const parseCourseIds = (payload) =>
  parseArrayField(payload.courseIds ?? payload["courseIds[]"] ?? payload.courseId)
    .map((item) => String(item).trim())
    .filter(Boolean);

const parseBulkItems = (body, key) => {
  const value = body[key] ?? body.items ?? body.records;
  let items = value;

  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      throw new AppError(400, `${key} must be a JSON array`);
    }
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, `${key} must be a non-empty array`);
  }

  if (items.length > 200) {
    throw new AppError(400, "Bulk create supports up to 200 records at a time");
  }

  return items;
};

const runInChunks = async (items, chunkSize, handler) => {
  const results = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    const chunkResults = await Promise.all(
      chunk.map((item, chunkIndex) => handler(item, index + chunkIndex)),
    );
    results.push(...chunkResults);
  }
  return results;
};

const normalizeGradeLevels = (gradeLevels) =>
  parseArrayField(gradeLevels)
    .map((item) => normalizeGradeLevel(item))
    .filter((item) => GRADE_LEVELS.includes(item));

const serializeBulkError = (error) => ({
  message: error?.message || "Failed to create record",
});

const createStudentRecord = async (payload, files) => {
  const {
    schoolId,
    schoolName,
    studentName,
    name,
    studentUserID,
    userId,
    studentPassword,
    password,
    confirmStudentPassword,
    confirmPassword,
    gradeLevel,
    status,
  } = payload;

  const finalName = studentName || name;
  const finalUserId = normalizeUserId(studentUserID || userId);
  const finalPassword = studentPassword || password;
  const finalConfirmPassword = confirmStudentPassword || confirmPassword;

  if (
    !finalName ||
    !finalUserId ||
    !finalPassword ||
    !finalConfirmPassword ||
    !gradeLevel
  ) {
    throw new AppError(
      400,
      "Name, userId, password, confirmPassword and gradeLevel are required",
    );
  }

  if (finalPassword !== finalConfirmPassword) {
    throw new AppError(400, "Passwords do not match");
  }

  const school = await ensureSchool({ schoolId, schoolName });
  if (!school) {
    throw new AppError(404, "School not found");
  }

  const exists = await User.findOne({ userId: finalUserId });
  if (exists) {
    throw new AppError(409, "User ID already exists");
  }

  const grade = ensureGrade(gradeLevel);
  const nextStatus = status || "active";

  const user = await User.create({
    name: finalName,
    userId: finalUserId,
    password: finalPassword,
    role: "student",
    school: school._id,
    gradeLevel: grade,
    status: nextStatus,
  });

  const securityQuestions = await parseSecurityQuestions(payload);

  const picture = {};
  if (files?.picture?.[0]) {
    const uploadResult = await uploadOnCloudinary(
      files.picture[0].buffer,
      "profiles",
    );
    picture.url = uploadResult.secure_url;
    picture.public_id = uploadResult.public_id;
  }

  const file = {};
  if (files?.file?.[0]) {
    const uploadResult = await uploadOnCloudinary(files.file[0].buffer, "files");
    file.url = uploadResult.secure_url;
    file.public_id = uploadResult.public_id;
  }

  let student;
  try {
    student = await Student.create({
      user: user._id,
      school: school._id,
      name: finalName,
      gradeLevel: grade,
      status: nextStatus,
      securityQuestions,
      picture,
      file,
    });
  } catch (error) {
    await User.findByIdAndDelete(user._id);
    throw error;
  }

  return {
    schoolId: school._id,
    item: {
      _id: student._id,
      studentName: student.name,
      userId: user.userId,
      schoolName: school.name,
      schoolId: school._id,
      gradeLevel: student.gradeLevel,
      status: student.status,
      picture: student.picture,
    },
  };
};

const createTeacherRecord = async (payload, files) => {
  const {
    schoolId,
    schoolName,
    teacherName,
    name,
    teacherUserID,
    userId,
    teacherPassword,
    password,
    confirmTeacherPassword,
    confirmPassword,
    gradeLevel,
    status,
  } = payload;

  const finalName = teacherName || name;
  const finalUserId = normalizeUserId(teacherUserID || userId);
  const finalPassword = teacherPassword || password;
  const finalConfirmPassword = confirmTeacherPassword || confirmPassword;
  const { firstName, lastName } = splitNameParts(finalName);

  if (
    !finalName ||
    !finalUserId ||
    !finalPassword ||
    !finalConfirmPassword ||
    !gradeLevel
  ) {
    throw new AppError(
      400,
      "Name, userId, password, confirmPassword and gradeLevel are required",
    );
  }

  if (finalPassword !== finalConfirmPassword) {
    throw new AppError(400, "Passwords do not match");
  }

  const school = await ensureSchool({ schoolId, schoolName });
  if (!school) throw new AppError(404, "School not found");

  const exists = await User.findOne({ userId: finalUserId });
  if (exists) throw new AppError(409, "User ID already exists");

  const teacherCourses = parseCourseIds(payload);
  if (teacherCourses.length > 0) {
    const invalidCourseIds = teacherCourses.filter(
      (courseId) => !mongoose.Types.ObjectId.isValid(courseId),
    );
    if (invalidCourseIds.length > 0) {
      throw new AppError(400, "Some course IDs are invalid");
    }

    const validCount = await Course.countDocuments({
      _id: { $in: teacherCourses },
    });
    if (validCount !== teacherCourses.length) {
      throw new AppError(400, "Some course IDs are invalid");
    }
  }

  const grade = ensureGrade(gradeLevel);
  const nextStatus = status || "active";

  const user = await User.create({
    name: finalName,
    firstName,
    lastName,
    userId: finalUserId,
    password: finalPassword,
    role: "teacher",
    school: school._id,
    gradeLevel: grade,
    status: nextStatus,
  });

  const picture = {};
  if (files?.picture?.[0]) {
    const upload = await uploadOnCloudinary(files.picture[0].buffer, "profiles");
    picture.url = upload.secure_url;
    picture.public_id = upload.public_id;
  }

  const file = {};
  if (files?.file?.[0]) {
    const upload = await uploadOnCloudinary(files.file[0].buffer, "files");
    file.url = upload.secure_url;
    file.public_id = upload.public_id;
  }

  let teacher;
  try {
    teacher = await Teacher.create({
      user: user._id,
      firstName,
      lastName,
      school: school._id,
      name: finalName,
      gradeLevel: grade,
      courses: teacherCourses,
      status: nextStatus,
      picture,
      file,
    });
  } catch (error) {
    await User.findByIdAndDelete(user._id);
    throw error;
  }

  return {
    schoolId: school._id,
    item: {
      _id: teacher._id,
      teacherName: teacher.name,
      userId: user.userId,
      schoolName: school.name,
      schoolId: school._id,
      gradeLevel: teacher.gradeLevel,
      status: teacher.status,
    },
  };
};

const createSchoolRecord = async (payload) => {
  const { name, schoolCode, gradeLevels, gradeLevel, status } = payload;
  if (!name || !schoolCode) {
    throw new AppError(400, "name and schoolCode are required");
  }

  const code = String(schoolCode).trim().toUpperCase();
  const normalizedGradeLevels = normalizeGradeLevels(
    gradeLevels ?? (gradeLevel ? [gradeLevel] : []),
  );

  return School.create({
    name,
    schoolCode: code,
    schooleCode: code,
    gradeLevels: normalizedGradeLevels,
    status: status || "active",
  });
};

export const getAdminDashboard = catchAsync(async (req, res) => {
  const [
    totalStudents,
    totalTeachers,
    totalSubjects,
    activeStudents,
    inactiveStudents,
    activeTeachers,
    inactiveTeachers,
  ] = await Promise.all([
    Student.countDocuments(),
    Teacher.countDocuments(),
    Course.countDocuments(),
    Student.countDocuments({ status: "active" }),
    Student.countDocuments({ status: "inactive" }),
    Teacher.countDocuments({ status: "active" }),
    Teacher.countDocuments({ status: "inactive" }),
  ]);

  const [subjectDistribution, monthlyStudentGrowth, activityByWeekday] =
    await Promise.all([
      Progress.aggregate([
        { $match: { status: "completed" } },
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
      Student.aggregate([
        { $match: { createdAt: { $type: "date" } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
            total: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, month: "$_id", total: 1 } },
      ]),
      Progress.aggregate([
        { $match: { performedAt: { $type: "date" } } },
        {
          $project: {
            weekday: { $dayOfWeek: "$performedAt" },
            activityMinutes: 1,
          },
        },
        { $group: { _id: "$weekday", minutes: { $sum: "$activityMinutes" } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

  const weekMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const activityHour = weekMap.map((day, idx) => {
    const found = activityByWeekday.find((i) => i._id === idx + 1);
    return { day, hours: Number(((found?.minutes || 0) / 60 || 0).toFixed(2)) };
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Dashboard fetched successfully",
    data: {
      counters: {
        totalStudents,
        activeStudents,
        inactiveStudents,
        totalTeachers,
        activeTeachers,
        inactiveTeachers,
        totalSubjects,
      },
      charts: {
        subjectDistribution,
        monthlyStudentGrowth,
        activityHour,
      },
    },
  });
});
export const addNewStudent = catchAsync(async (req, res, next) => {
  const created = await createStudentRecord(req.body, req.files);
  await syncSchoolCounts(created.schoolId);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Student created successfully",
    data: created.item,
  });
});

export const addBulkStudents = catchAsync(async (req, res) => {
  const students = parseBulkItems(req.body, "students");
  const created = [];
  const failed = [];
  const touchedSchoolIds = new Set();

  const results = await runInChunks(students, 10, async (student, index) => {
    try {
      const result = await createStudentRecord(student);
      return { type: "created", result };
    } catch (error) {
      return {
        type: "failed",
        failure: { index, item: student, ...serializeBulkError(error) },
      };
    }
  });

  for (const item of results) {
    if (item.type === "created") {
      created.push(item.result.item);
      touchedSchoolIds.add(String(item.result.schoolId));
    } else {
      failed.push(item.failure);
    }
  }

  await Promise.all(
    [...touchedSchoolIds].map((schoolId) => syncSchoolCounts(schoolId)),
  );

  sendResponse(res, {
    statusCode: 201,
    success: failed.length === 0,
    message:
      failed.length === 0
        ? "Students created successfully"
        : "Bulk student create completed with some failures",
    data: { created, failed },
  });
});

export const getStudents = catchAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  if (req.query.status) filter.status = req.query.status;
  if (req.query.schoolId) filter.school = req.query.schoolId;
  if (req.query.gradeLevel)
    filter.gradeLevel = normalizeGradeLevel(req.query.gradeLevel);

  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    const [users, schools] = await Promise.all([
      User.find(
        { role: "student", $or: [{ name: regex }, { userId: regex }] },
        { _id: 1 },
      ),
      School.find({ name: regex }, { _id: 1 }),
    ]);

    filter.$or = [{ name: regex }];
    if (users.length)
      filter.$or.push({ user: { $in: users.map((u) => u._id) } });
    if (schools.length)
      filter.$or.push({ school: { $in: schools.map((s) => s._id) } });
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
        schoolId: item.school?._id,
        gradeLevel: item.gradeLevel,
        status: item.status,
      })),
      meta: getPaginationMeta({ page, limit, total }),
    },
  });
});

export const getStudentsExport = catchAsync(async (req, res) => {
  const filter = {};

  if (req.query.status) filter.status = req.query.status;
  if (req.query.schoolId) filter.school = req.query.schoolId;
  if (req.query.gradeLevel)
    filter.gradeLevel = normalizeGradeLevel(req.query.gradeLevel);

  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    const [users, schools] = await Promise.all([
      User.find(
        { role: "student", $or: [{ name: regex }, { userId: regex }] },
        { _id: 1 },
      ),
      School.find({ name: regex }, { _id: 1 }),
    ]);

    filter.$or = [{ name: regex }];
    if (users.length)
      filter.$or.push({ user: { $in: users.map((user) => user._id) } });
    if (schools.length)
      filter.$or.push({ school: { $in: schools.map((school) => school._id) } });
  }

  const students = await Student.find(filter)
    .populate("school", "name")
    .populate("user", "userId mac_id")
    .sort({ createdAt: -1 })
    .lean();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Student export data fetched successfully",
    data: students.map((student) => ({
      serialNumber: student.user?.mac_id || "",
      schoolName: student.school?.name || "",
      studentName: student.name,
      userId: student.user?.userId || "",
      gradeLevel: student.gradeLevel,
    })),
  });
});

export const getStudentById = catchAsync(async (req, res, next) => {
  const student = await Student.findById(req.params.studentId)
    .populate("school", "name schoolCode")
    .populate("user", "userId name")
    .lean();

  if (!student) {
    return next(new AppError(404, "Student not found"));
  }

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
        picture: student.picture || { url: "", public_id: "" },
      },
      progressSheet,
    },
  });
});

export const updateStudent = catchAsync(async (req, res, next) => {
  const student = await Student.findById(req.params.studentId);
  if (!student) return next(new AppError(404, "Student not found"));

  const user = await User.findById(student.user);
  if (!user) return next(new AppError(404, "Linked user not found"));

  if (req.body.studentName || req.body.name) {
    const updatedName = req.body.studentName || req.body.name;
    student.name = updatedName;
    user.name = updatedName;
  }

  if (req.body.gradeLevel) {
    const grade = ensureGrade(req.body.gradeLevel);
    student.gradeLevel = grade;
    user.gradeLevel = grade;
  }

  if (req.body.status) {
    student.status = req.body.status;
    user.status = req.body.status;
  }

  if (req.body.userId) {
    const nextUserId = normalizeUserId(req.body.userId);
    const exists = await User.findOne({
      userId: nextUserId,
      _id: { $ne: user._id },
    });
    if (exists) return next(new AppError(409, "User ID already in use"));
    user.userId = nextUserId;
  }

  if (req.body.password) {
    user.password = req.body.password;
  }

  if (req.body.schoolId) {
    const school = await School.findById(req.body.schoolId);
    if (!school) return next(new AppError(404, "School not found"));
    student.school = school._id;
    user.school = school._id;
  }

  const securityQuestions = await parseSecurityQuestions(req.body);
  if (securityQuestions.length > 0) {
    student.securityQuestions = securityQuestions;
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
  await syncSchoolCounts(student.school);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Student updated successfully",
    data: {
      _id: student._id,
      studentName: student.name,
      userId: user.userId,
      gradeLevel: student.gradeLevel,
      status: student.status,
    },
  });
});

export const updateStudentsGradeLevel = catchAsync(async (req, res) => {
  const studentIds = parseBulkRecordIds(req.body.studentIds, "Student");
  const gradeLevel = ensureGrade(req.body.gradeLevel);
  const updatedCount = await updatePeopleGradeLevel({
    Model: Student,
    ids: studentIds,
    gradeLevel,
    recordLabel: "Student",
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Selected students' grade level updated successfully",
    data: { updatedCount, gradeLevel },
  });
});

export const deleteStudent = catchAsync(async (req, res, next) => {
  const student = await Student.findById(req.params.studentId);
  if (!student) return next(new AppError(404, "Student not found"));

  await Promise.all([
    User.findByIdAndDelete(student.user),
    Progress.deleteMany({ student: student._id }),
    student.deleteOne(),
  ]);

  await syncSchoolCounts(student.school);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Student deleted successfully",
  });
});

export const addNewTeacher = catchAsync(async (req, res, next) => {
  const created = await createTeacherRecord(req.body, req.files);
  await syncSchoolCounts(created.schoolId);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Teacher created successfully",
    data: created.item,
  });
});

export const addBulkTeachers = catchAsync(async (req, res) => {
  const teachers = parseBulkItems(req.body, "teachers");
  const created = [];
  const failed = [];
  const touchedSchoolIds = new Set();

  for (const [index, teacher] of teachers.entries()) {
    try {
      const result = await createTeacherRecord(teacher);
      created.push(result.item);
      touchedSchoolIds.add(String(result.schoolId));
    } catch (error) {
      failed.push({ index, item: teacher, ...serializeBulkError(error) });
    }
  }

  await Promise.all(
    [...touchedSchoolIds].map((schoolId) => syncSchoolCounts(schoolId)),
  );

  sendResponse(res, {
    statusCode: 201,
    success: failed.length === 0,
    message:
      failed.length === 0
        ? "Teachers created successfully"
        : "Bulk teacher create completed with some failures",
    data: { created, failed },
  });
});

export const getTeachers = catchAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  if (req.query.status) filter.status = req.query.status;
  if (req.query.schoolId) filter.school = req.query.schoolId;
  if (req.query.gradeLevel)
    filter.gradeLevel = normalizeGradeLevel(req.query.gradeLevel);

  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    const [users, schools] = await Promise.all([
      User.find(
        { role: "teacher", $or: [{ name: regex }, { userId: regex }] },
        { _id: 1 },
      ),
      School.find({ name: regex }, { _id: 1 }),
    ]);

    filter.$or = [{ name: regex }];
    if (users.length)
      filter.$or.push({ user: { $in: users.map((u) => u._id) } });
    if (schools.length)
      filter.$or.push({ school: { $in: schools.map((s) => s._id) } });
  }

  const [items, total] = await Promise.all([
    Teacher.find(filter)
      .populate("school", "name schoolCode")
      .populate("user", "userId")
      .populate("courses", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Teacher.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Teachers fetched successfully",
    data: {
      items: items.map((item) => ({
        _id: item._id,
        teacherName: item.name,
        userId: item.user?.userId,
        schoolName: item.school?.name,
        schoolId: item.school?._id,
        gradeLevel: item.gradeLevel,
        status: item.status,
        courses: item.courses?.map((c) => ({ _id: c._id, name: c.name })) || [],
      })),
      meta: getPaginationMeta({ page, limit, total }),
    },
  });
});

export const getTeachersExport = catchAsync(async (req, res) => {
  const filter = {};

  if (req.query.status) filter.status = req.query.status;
  if (req.query.schoolId) filter.school = req.query.schoolId;
  if (req.query.gradeLevel)
    filter.gradeLevel = normalizeGradeLevel(req.query.gradeLevel);

  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    const [users, schools] = await Promise.all([
      User.find(
        { role: "teacher", $or: [{ name: regex }, { userId: regex }] },
        { _id: 1 },
      ),
      School.find({ name: regex }, { _id: 1 }),
    ]);

    filter.$or = [{ name: regex }];
    if (users.length)
      filter.$or.push({ user: { $in: users.map((user) => user._id) } });
    if (schools.length)
      filter.$or.push({ school: { $in: schools.map((school) => school._id) } });
  }

  const teachers = await Teacher.find(filter)
    .populate("school", "name")
    .populate("user", "userId mac_id")
    .sort({ createdAt: -1 })
    .lean();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Teacher export data fetched successfully",
    data: teachers.map((teacher) => ({
      serialNumber: teacher.user?.mac_id || "",
      schoolName: teacher.school?.name || "",
      teacherName: teacher.name,
      userId: teacher.user?.userId || "",
      gradeLevel: teacher.gradeLevel,
    })),
  });
});

export const getTeacherById = catchAsync(async (req, res, next) => {
  const teacher = await Teacher.findById(req.params.teacherId)
    .populate("school", "name schoolCode")
    .populate("user", "userId name")
    .populate("courses", "name")
    .lean();

  if (!teacher) return next(new AppError(404, "Teacher not found"));

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Teacher details fetched successfully",
    data: {
      _id: teacher._id,
      teacherName: teacher.name,
      userId: teacher.user?.userId,
      schoolName: teacher.school?.name,
      schoolCode: teacher.school?.schoolCode,
      gradeLevel: teacher.gradeLevel,
      status: teacher.status,
      picture: teacher.picture || { url: "", public_id: "" },
      courses: teacher.courses || [],
    },
  });
});

export const getTeacherOverview = catchAsync(async (req, res, next) => {
  const teacher = await Teacher.findById(req.params.teacherId)
    .populate("school", "name schoolCode")
    .populate("courses", "name")
    .lean();

  if (!teacher) return next(new AppError(404, "Teacher not found"));

  const courses = teacher.courses || [];
  const courseIds = courses.map((course) => course._id);

  const subjectQuery = req.query.subject ? normalizeText(req.query.subject) : null;
  const matchedCourse = subjectQuery
    ? courses.find((course) => normalizeText(course.name) === subjectQuery)
    : null;
  const trendCourseIds = matchedCourse ? [matchedCourse._id] : courseIds;

  const students = await Student.find({
    school: teacher.school?._id,
    gradeLevel: teacher.gradeLevel,
  })
    .select("_id")
    .lean();
  const studentIds = students.map((student) => student._id);

  const range = getPastYearRange();

  const [monthlyTrend, performanceRange, recentWork] = await Promise.all([
    getTeacherCompletionTrend({ studentIds, courseIds: trendCourseIds, range }),
    getTeacherCoursePerformance({ studentIds, courseIds }),
    getTeacherRecentWork({ studentIds, courseIds }),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Teacher overview fetched successfully",
    data: {
      courses: courses.map((course) => ({ _id: course._id, name: course.name })),
      totalStudents: studentIds.length,
      monthlyTrend,
      performanceRange,
      recentWork,
    },
  });
});

export const updateTeacher = catchAsync(async (req, res, next) => {
  const teacher = await Teacher.findById(req.params.teacherId);
  if (!teacher) return next(new AppError(404, "Teacher not found"));

  const user = await User.findById(teacher.user);
  if (!user) return next(new AppError(404, "Linked user not found"));

  if (req.body.teacherName || req.body.name) {
    const updatedName = req.body.teacherName || req.body.name;
    teacher.name = updatedName;
    user.name = updatedName;
  }

  if (req.body.gradeLevel) {
    const grade = ensureGrade(req.body.gradeLevel);
    teacher.gradeLevel = grade;
    user.gradeLevel = grade;
  }

  if (req.body.status) {
    teacher.status = req.body.status;
    user.status = req.body.status;
  }

  if (req.body.userId) {
    const nextUserId = normalizeUserId(req.body.userId);
    const exists = await User.findOne({
      userId: nextUserId,
      _id: { $ne: user._id },
    });
    if (exists) return next(new AppError(409, "User ID already in use"));
    user.userId = nextUserId;
  }

  if (req.body.password) {
    user.password = req.body.password;
  }

  if (req.body.schoolId) {
    const school = await School.findById(req.body.schoolId);
    if (!school) return next(new AppError(404, "School not found"));
    teacher.school = school._id;
    user.school = school._id;
  }

  const hasCourseIdsField =
    Object.prototype.hasOwnProperty.call(req.body, "courseIds") ||
    Object.prototype.hasOwnProperty.call(req.body, "courseIds[]");

  if (hasCourseIdsField) {
    const courseIds = parseCourseIds(req.body);
    const invalidCourseIds = courseIds.filter(
      (courseId) => !mongoose.Types.ObjectId.isValid(courseId),
    );
    if (invalidCourseIds.length > 0) {
      return next(new AppError(400, "Some course IDs are invalid"));
    }

    const validCount = await Course.countDocuments({
      _id: { $in: courseIds },
    });
    if (validCount !== courseIds.length) {
      return next(new AppError(400, "Some course IDs are invalid"));
    }

    teacher.courses = courseIds;
  }

  if (req.files?.picture?.[0]) {
    const upload = await uploadOnCloudinary(req.files.picture[0].buffer, "profiles");
    teacher.picture = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  if (req.files?.file?.[0]) {
    const upload = await uploadOnCloudinary(req.files.file[0].buffer, "files");
    teacher.file = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  await Promise.all([teacher.save(), user.save()]);
  await syncSchoolCounts(teacher.school);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Teacher updated successfully",
    data: {
      _id: teacher._id,
      teacherName: teacher.name,
      userId: user.userId,
      gradeLevel: teacher.gradeLevel,
      status: teacher.status,
    },
  });
});

export const updateTeachersGradeLevel = catchAsync(async (req, res) => {
  const teacherIds = parseBulkRecordIds(req.body.teacherIds, "Teacher");
  const gradeLevel = ensureGrade(req.body.gradeLevel);
  const updatedCount = await updatePeopleGradeLevel({
    Model: Teacher,
    ids: teacherIds,
    gradeLevel,
    recordLabel: "Teacher",
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Selected teachers' grade level updated successfully",
    data: { updatedCount, gradeLevel },
  });
});

export const deleteTeacher = catchAsync(async (req, res, next) => {
  const teacher = await Teacher.findById(req.params.teacherId);
  if (!teacher) return next(new AppError(404, "Teacher not found"));

  await Promise.all([
    User.findByIdAndDelete(teacher.user),
    teacher.deleteOne(),
  ]);
  await syncSchoolCounts(teacher.school);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Teacher deleted successfully",
  });
});
export const getSchools = catchAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  if (req.query.status) filter.status = req.query.status;
  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    filter.$or = [{ name: regex }, { schoolCode: regex }];
  }

  const [items, total] = await Promise.all([
    School.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    School.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Schools fetched successfully",
    data: {
      items,
      meta: getPaginationMeta({ page, limit, total }),
    },
  });
});

export const getSchoolsExport = catchAsync(async (req, res) => {
  const filter = {};

  if (req.query.status) filter.status = req.query.status;
  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    filter.$or = [{ name: regex }, { schoolCode: regex }];
  }

  const schools = await School.find(filter).sort({ createdAt: -1 }).lean();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "School export data fetched successfully",
    data: schools.map((school, index) => ({
      serialNumber: index + 1,
      schoolName: school.name,
      schoolCode: school.schoolCode || school.schooleCode || "",
      gradeLevel: school.gradeLevels?.join(", ") || "",
    })),
  });
});

export const addSchool = catchAsync(async (req, res, next) => {
  const school = await createSchoolRecord(req.body);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "School created successfully",
    data: school,
  });
});

export const addBulkSchools = catchAsync(async (req, res) => {
  const schools = parseBulkItems(req.body, "schools");
  const created = [];
  const failed = [];

  for (const [index, school] of schools.entries()) {
    try {
      created.push(await createSchoolRecord(school));
    } catch (error) {
      failed.push({ index, item: school, ...serializeBulkError(error) });
    }
  }

  sendResponse(res, {
    statusCode: 201,
    success: failed.length === 0,
    message:
      failed.length === 0
        ? "Schools created successfully"
        : "Bulk school create completed with some failures",
    data: { created, failed },
  });
});

export const updateSchool = catchAsync(async (req, res, next) => {
  const school = await School.findById(req.params.schoolId);
  if (!school) return next(new AppError(404, "School not found"));

  if (req.body.name) school.name = req.body.name;
  if (req.body.status) school.status = req.body.status;
  if (req.body.schoolCode) {
    const code = String(req.body.schoolCode).trim().toUpperCase();
    school.schoolCode = code;
    school.schooleCode = code;
  }
  if (Array.isArray(req.body.gradeLevels)) {
    school.gradeLevels = req.body.gradeLevels
      .map((item) => normalizeGradeLevel(item))
      .filter((item) => GRADE_LEVELS.includes(item));
  }

  await school.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "School updated successfully",
    data: school,
  });
});

export const updateSchoolsGradeLevel = catchAsync(async (req, res) => {
  const schoolIds = parseBulkRecordIds(req.body.schoolIds, "School");
  const gradeLevel = ensureGrade(req.body.gradeLevel);
  const existingCount = await School.countDocuments({ _id: { $in: schoolIds } });

  if (existingCount !== schoolIds.length) {
    throw new AppError(404, "Some selected schools were not found");
  }

  await School.updateMany(
    { _id: { $in: schoolIds } },
    { $set: { gradeLevels: [gradeLevel] } },
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Selected schools' grade level updated successfully",
    data: { updatedCount: existingCount, gradeLevel },
  });
});

export const deleteSchool = catchAsync(async (req, res, next) => {
  const school = await School.findById(req.params.schoolId);
  if (!school) return next(new AppError(404, "School not found"));

  const [students, teachers] = await Promise.all([
    Student.countDocuments({ school: school._id }),
    Teacher.countDocuments({ school: school._id }),
  ]);

  if (students > 0 || teachers > 0) {
    return next(
      new AppError(
        400,
        "Cannot delete school with linked students or teachers",
      ),
    );
  }

  await school.deleteOne();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "School deleted successfully",
  });
});

export const addCourse = catchAsync(async (req, res, next) => {
  const { name, description, gradeLevels, status } = req.body;
  if (!name) return next(new AppError(400, "name is required"));

  const normalizedGradeLevels = Array.isArray(gradeLevels)
    ? gradeLevels
      .map((item) => normalizeGradeLevel(item))
      .filter((item) => GRADE_LEVELS.includes(item))
    : [];

  const image = {};
  if (req.files?.image) {
    const upload = await uploadOnCloudinary(req.files.image[0].buffer);
    image.public_id = upload.public_id;
    image.url = upload.secure_url;
  }

  const course = await Course.create({
    name,
    description,
    gradeLevels: normalizedGradeLevels,
    status: status || "active",
    image,
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Course created successfully",
    data: course,
  });
});

export const getCourses = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.gradeLevel)
    filter.gradeLevels = normalizeGradeLevel(req.query.gradeLevel);
  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    filter.$or = [{ name: regex }, { description: regex }];
  }

  const courses = await Course.find(filter).sort({ name: 1 });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Courses fetched successfully",
    data: courses,
  });
});

export const updateCourse = catchAsync(async (req, res, next) => {
  const course = await Course.findById(req.params.courseId);
  if (!course) return next(new AppError(404, "Course not found"));

  if (req.body.name) course.name = req.body.name;
  if (req.body.description !== undefined)
    course.description = req.body.description;
  if (req.body.status) course.status = req.body.status;
  if (Array.isArray(req.body.gradeLevels)) {
    course.gradeLevels = req.body.gradeLevels
      .map((item) => normalizeGradeLevel(item))
      .filter((item) => GRADE_LEVELS.includes(item));
  }

  if (req.files?.image) {
    const upload = await uploadOnCloudinary(req.files.image[0].buffer);
    course.image.public_id = upload.public_id;
    course.image.url = upload.secure_url;
  }

  await course.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Course updated successfully",
    data: course,
  });
});

export const deleteCourse = catchAsync(async (req, res, next) => {
  const course = await Course.findById(req.params.courseId);
  if (!course) return next(new AppError(404, "Course not found"));

  const [teacherCount, progressCount] = await Promise.all([
    Teacher.countDocuments({ courses: course._id }),
    Progress.countDocuments({ course: course._id }),
  ]);

  if (teacherCount > 0 || progressCount > 0) {
    return next(new AppError(400, "Cannot delete course with linked records"));
  }

  await course.deleteOne();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Course deleted successfully",
  });
});

export const addLesson = catchAsync(async (req, res, next) => {
  const {
    courseId,
    gradeLevel,
    strand,
    subStrand,
    lessonNumber,
    title,
    description,
    estimatedMinutes,
    resources,
    status,
  } = req.body;

  if (
    !courseId ||
    !gradeLevel ||
    !strand ||
    !subStrand ||
    !lessonNumber ||
    !title
  ) {
    return next(
      new AppError(
        400,
        "courseId, gradeLevel, strand, subStrand, lessonNumber and title are required",
      ),
    );
  }

  const course = await Course.findById(courseId);
  if (!course) return next(new AppError(404, "Course not found"));

  const lesson = await Lesson.create({
    course: course._id,
    gradeLevel: ensureGrade(gradeLevel),
    strand,
    subStrand,
    lessonNumber,
    title,
    description,
    estimatedMinutes: estimatedMinutes || 30,
    resources: Array.isArray(resources) ? resources : [],
    status: status || "active",
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Lesson created successfully",
    data: lesson,
  });
});

export const getLessons = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.courseId) filter.course = req.query.courseId;
  if (req.query.gradeLevel)
    filter.gradeLevel = normalizeGradeLevel(req.query.gradeLevel);
  if (req.query.status) filter.status = req.query.status;

  const lessons = await Lesson.find(filter)
    .populate("course", "name")
    .sort({ course: 1, strand: 1, subStrand: 1, lessonNumber: 1 });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lessons fetched successfully",
    data: lessons,
  });
});

export const updateLesson = catchAsync(async (req, res, next) => {
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) return next(new AppError(404, "Lesson not found"));

  if (req.body.courseId) {
    const course = await Course.findById(req.body.courseId);
    if (!course) return next(new AppError(404, "Course not found"));
    lesson.course = course._id;
  }
  if (req.body.gradeLevel) lesson.gradeLevel = ensureGrade(req.body.gradeLevel);
  if (req.body.strand) lesson.strand = req.body.strand;
  if (req.body.subStrand) lesson.subStrand = req.body.subStrand;
  if (req.body.lessonNumber) lesson.lessonNumber = req.body.lessonNumber;
  if (req.body.title) lesson.title = req.body.title;
  if (req.body.description !== undefined)
    lesson.description = req.body.description;
  if (req.body.estimatedMinutes !== undefined)
    lesson.estimatedMinutes = req.body.estimatedMinutes;
  if (req.body.status) lesson.status = req.body.status;
  if (Array.isArray(req.body.resources)) lesson.resources = req.body.resources;

  await lesson.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lesson updated successfully",
    data: lesson,
  });
});

export const deleteLesson = catchAsync(async (req, res, next) => {
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) return next(new AppError(404, "Lesson not found"));

  const progressCount = await Progress.countDocuments({ lesson: lesson._id });
  if (progressCount > 0) {
    return next(new AppError(400, "Cannot delete lesson with linked progress"));
  }

  await lesson.deleteOne();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lesson deleted successfully",
  });
});

export const getMyProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).lean();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile fetched successfully",
    data: user,
  });
});

export const updateMyProfile = catchAsync(async (req, res) => {
  const payload = {};
  for (const key of ["name", "firstName", "lastName", "email"]) {
    if (req.body[key] !== undefined) payload[key] = req.body[key];
  }

  if (payload.email) {
    payload.email = String(payload.email).trim().toLowerCase();
  }

  if (req.files?.picture?.[0]) {
    const upload = await uploadOnCloudinary(req.files.picture[0].buffer, "profiles");
    payload.profile = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  const user = await User.findByIdAndUpdate(req.user._id, payload, {
    new: true,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile updated successfully",
    data: user,
  });
});

export const changeMyPassword = catchAsync(async (req, res, next) => {
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

export const getSupportTickets = catchAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.role) filter.role = req.query.role;

  const [items, total] = await Promise.all([
    SupportTicket.find(filter)
      .populate("user", "name email userId role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SupportTicket.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Support tickets fetched successfully",
    data: {
      items,
      meta: getPaginationMeta({ page, limit, total }),
    },
  });
});

export const resolveSupportTicket = catchAsync(async (req, res, next) => {
  const ticket = await SupportTicket.findById(req.params.ticketId);
  if (!ticket) return next(new AppError(404, "Support ticket not found"));

  ticket.status = req.body.status || "resolved";
  if (req.body.resolutionNote !== undefined) {
    ticket.resolutionNote = req.body.resolutionNote;
  }
  await ticket.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Support ticket updated successfully",
    data: ticket,
  });
});
