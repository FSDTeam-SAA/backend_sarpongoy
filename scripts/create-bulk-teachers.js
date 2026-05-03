import dotenv from "dotenv";
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Teacher } from "../models/teacher.model.js";
import { School } from "../models/school.model.js";
import { Course } from "../models/course.model.js";

dotenv.config();

const DEFAULT_COUNT = 10;
const DEFAULT_GRADE_LEVEL = "JHS 1";
const DEFAULT_STATUS = "active";
const DEFAULT_SCHOOL_CODE = "ACH-JHS-005";
const DEFAULT_PREFIX = "teacheruser";

const args = process.argv.slice(2);

const getArgValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return fallback;
  return args[index + 1];
};

const count = Number(getArgValue("--count", DEFAULT_COUNT));
const gradeLevel = getArgValue("--grade", DEFAULT_GRADE_LEVEL);
const schoolId = getArgValue("--school-id", "");
const schoolCode = getArgValue("--school-code", DEFAULT_SCHOOL_CODE);
const schoolName = getArgValue("--school-name", "");
const outputPath = getArgValue("--out", "bulk-teacher-credentials.csv");
const prefix = getArgValue("--prefix", DEFAULT_PREFIX);

const credentials = [];

const normalizeUserId = (index) => `${prefix}${String(index).padStart(2, "0")}`;
const normalizePassword = (index) => `Password@${String(index).padStart(2, "0")}`;

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

const findSchool = async () => {
  if (schoolId && mongoose.Types.ObjectId.isValid(schoolId)) {
    return School.findById(schoolId);
  }

  if (schoolCode) {
    const byCode = await School.findOne({
      schoolCode: String(schoolCode).trim().toUpperCase(),
    });
    if (byCode) return byCode;
  }

  if (schoolName) {
    const byName = await School.findOne({ name: schoolName });
    if (byName) return byName;
  }

  return School.findOne({ status: "active" }).sort({ totalTeacher: -1, createdAt: 1 });
};

const findTeacherCourses = async () =>
  Course.find({
    status: "active",
    gradeLevels: gradeLevel,
  })
    .sort({ name: 1 })
    .lean();

const syncSchoolCounts = async (school) => {
  const totalTeacher = await Teacher.countDocuments({ school: school._id });
  await School.findByIdAndUpdate(school._id, { totalTeacher });
};

try {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("count must be a positive integer");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const school = await findSchool();
  if (!school) {
    throw new Error("No school found for bulk teacher creation");
  }

  const teacherCourses = await findTeacherCourses();
  const courseIds = teacherCourses.map((course) => course._id);

  for (let index = 1; index <= count; index += 1) {
    const userId = normalizeUserId(index);
    const password = normalizePassword(index);
    const teacherName = `Teacher ${String(index).padStart(2, "0")} Demo`;
    const { firstName, lastName } = splitNameParts(teacherName);

    let user = await User.findOne({ userId: userId.toUpperCase() }).select("+password");
    if (!user) {
      user = await User.create({
        name: teacherName,
        firstName,
        lastName,
        userId,
        password,
        role: "teacher",
        school: school._id,
        gradeLevel,
        status: DEFAULT_STATUS,
      });
      user = await User.findById(user._id).select("+password");
    } else {
      user.name = teacherName;
      user.firstName = firstName;
      user.lastName = lastName;
      user.password = password;
      user.role = "teacher";
      user.school = school._id;
      user.gradeLevel = gradeLevel;
      user.status = DEFAULT_STATUS;
      await user.save();
    }

    let teacher = await Teacher.findOne({ user: user._id });
    if (!teacher) {
      teacher = await Teacher.create({
        user: user._id,
        firstName,
        lastName,
        school: school._id,
        courses: courseIds,
        name: teacherName,
        gradeLevel,
        status: DEFAULT_STATUS,
      });
    } else {
      teacher.firstName = firstName;
      teacher.lastName = lastName;
      teacher.school = school._id;
      teacher.courses = courseIds;
      teacher.name = teacherName;
      teacher.gradeLevel = gradeLevel;
      teacher.status = DEFAULT_STATUS;
      await teacher.save();
    }

    credentials.push({
      userId,
      password,
      schoolName: school.name,
      schoolCode: school.schoolCode,
      gradeLevel,
      courseCount: courseIds.length,
      userDbId: String(user._id),
      teacherDbId: String(teacher._id),
    });
  }

  await syncSchoolCounts(school);

  const lines = [
    "userId,password,schoolName,schoolCode,gradeLevel,courseCount,userDbId,teacherDbId",
    ...credentials.map((item) =>
      [
        item.userId,
        item.password,
        `"${item.schoolName.replace(/"/g, '""')}"`,
        item.schoolCode,
        item.gradeLevel,
        item.courseCount,
        item.userDbId,
        item.teacherDbId,
      ].join(","),
    ),
  ];

  await import("node:fs/promises").then((fs) =>
    fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8"),
  );

  const verifiedResults = await Promise.all(
    credentials.map(async ({ userId, password }) => {
      const existing = await User.findOne({ userId: userId.toUpperCase() }).select("+password");
      if (!existing) return { userId, ok: false, reason: "missing user" };
      const ok = await User.isPasswordMatched(password, existing.password);
      return { userId, ok, reason: ok ? "" : "password mismatch" };
    }),
  );

  const failed = verifiedResults.filter((item) => !item.ok);

  console.log(
    JSON.stringify(
      {
        createdOrUpdated: credentials.length,
        school: {
          _id: String(school._id),
          name: school.name,
          schoolCode: school.schoolCode,
        },
        gradeLevel,
        assignedCourses: teacherCourses.map((course) => course.name),
        outputPath,
        verified: failed.length === 0,
        failed,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
