import AppError from "../errors/AppError.js";
import { Course } from "../models/course.model.js";
import { Progress } from "../models/progress.model.js";
import { Student } from "../models/student.model.js";
import {
  buildStudentProgressMatch,
  getCourseWiseOverview,
  getDateRangeFromPeriod,
  getMonthlyActivityTrend,
  getOverviewGradeLevel,
  getQuizScoreTable,
  getStudentLoginStatus,
  getStudentProgressSummary,
  getTeacherRecentWork,
} from "../controllers/teacher.controller.js";

const normalizeSubjectName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ");

const isAllSubject = (subject) =>
  !subject || normalizeSubjectName(subject) === "all";

const matchesSubject = (courseName, subject) => {
  const normalizedCourse = normalizeSubjectName(courseName);
  const normalizedSubject = normalizeSubjectName(subject);
  const aliases = {
    math: ["math", "mathematics"],
    mathematics: ["math", "mathematics"],
    "social science": ["social science", "social studies"],
    "social studies": ["social science", "social studies"],
    "religious and moral education": ["religious and moral education"],
  };

  return (aliases[normalizedSubject] || [normalizedSubject]).includes(
    normalizedCourse,
  );
};

export const filterCoursesBySubject = async (courseIds, subject) => {
  if (isAllSubject(subject)) return courseIds;

  const courses = await Course.find({ _id: { $in: courseIds } })
    .select("name")
    .lean();

  return courses
    .filter((course) => matchesSubject(course.name, subject))
    .map((course) => course._id.toString());
};

const getEmptyOverview = () => ({
  summary: {
    activityCount: 0,
    totalHours: 0,
    avgDailyHours: 0,
    avgQuizScore: 0,
  },
  subjectProgress: [],
  courseWiseOverview: [],
  monthlyActivity: {
    months: [],
    totals: { avgDailyHours: 0, avgQuizScore: 0 },
  },
  activityBreakdown: [],
  recentWork: [],
  quizScoreTable: [],
});

const buildResponse = ({
  student,
  gradeLevel,
  timePeriod,
  subject,
  overview,
}) => ({
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
  overview,
});

export async function getStudentOverviewData({
  studentId,
  gradeLevel = "ALL",
  subject = "ALL",
  timePeriod = "Today",
  courseId = null,
  filteredCourseIds = null,
  allCourseIds = null,
}) {
  const student = await Student.findById(studentId)
    .populate("school", "name schoolCode")
    .populate("user", "userId name lastLoginAt")
    .lean();
  if (!student) throw new AppError(404, "Student not found");

  let finalFilteredIds = filteredCourseIds?.map(String) ?? null;
  let finalAllIds = allCourseIds?.map(String) ?? null;

  if (finalFilteredIds === null || finalAllIds === null) {
    const distinctCourses = await Progress.distinct("course", {
      student: student._id,
    });
    const studentCourseIds = distinctCourses.map(String);

    if (finalFilteredIds === null) {
      finalFilteredIds = await filterCoursesBySubject(
        studentCourseIds,
        subject,
      );
    }
    if (finalAllIds === null) finalAllIds = studentCourseIds;
  }

  if (courseId) {
    const normalizedCourseId = String(courseId);
    if (!finalAllIds.includes(normalizedCourseId)) {
      throw new AppError(400, "Course not associated with this student");
    }
    if (
      !isAllSubject(subject) &&
      !finalFilteredIds.includes(normalizedCourseId)
    ) {
      throw new AppError(400, "courseId does not match subject filter");
    }
    finalFilteredIds = [normalizedCourseId];
  }

  // An explicit empty scope means the selected subject has no data. It must
  // not become an unrestricted Progress query.
  if (finalFilteredIds.length === 0) {
    return buildResponse({
      student,
      gradeLevel,
      timePeriod,
      subject,
      overview: getEmptyOverview(),
    });
  }

  const range = getDateRangeFromPeriod(timePeriod);
  const effectiveGradeLevel = getOverviewGradeLevel(gradeLevel);
  const matchBase = buildStudentProgressMatch({
    studentId: student._id,
    courseIds: finalFilteredIds,
    gradeLevel: effectiveGradeLevel,
    range,
  });

  const [
    progressSheet,
    courseWiseOverview,
    monthlyActivity,
    recentWork,
    activityBreakdown,
    quizScoreTable,
  ] = await Promise.all([
    getStudentProgressSummary({
      studentId: student._id,
      courseIds: finalFilteredIds,
      gradeLevel: effectiveGradeLevel,
      range,
      timePeriod,
    }),
    getCourseWiseOverview({
      studentId: student._id,
      courseIds: finalFilteredIds,
      gradeLevel: effectiveGradeLevel,
      range,
      timePeriod,
    }),
    getMonthlyActivityTrend({
      studentIds: [student._id],
      courseIds: finalFilteredIds,
      gradeLevel: effectiveGradeLevel,
    }),
    getTeacherRecentWork({
      studentId: student._id,
      courseIds: finalFilteredIds,
      gradeLevel: effectiveGradeLevel,
      range,
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
    getQuizScoreTable({
      studentId: student._id,
      courseIds: finalFilteredIds,
      gradeLevel: effectiveGradeLevel,
      range,
    }),
  ]);

  return buildResponse({
    student,
    gradeLevel,
    timePeriod,
    subject,
    overview: {
      summary: progressSheet.summary,
      subjectProgress: progressSheet.subjectProgress,
      courseWiseOverview,
      monthlyActivity,
      activityBreakdown,
      recentWork,
      quizScoreTable,
    },
  });
}
