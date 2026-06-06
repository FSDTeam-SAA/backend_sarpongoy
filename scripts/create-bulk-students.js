import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "../models/user.model.js";
import { Student } from "../models/student.model.js";
import { School } from "../models/school.model.js";
import { DEFAULT_SECURITY_QUESTIONS } from "../utils/securityQuestions.js";

dotenv.config();

const DEFAULT_COUNT = 60;
const DEFAULT_START = 1;
const DEFAULT_GRADE_LEVEL = "JHS 1";
const DEFAULT_STATUS = "active";
const DEFAULT_SCHOOL_CODE = "ACH-JHS-005";

const args = process.argv.slice(2);

const getArgValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return fallback;
  return args[index + 1];
};

const count = Number(getArgValue("--count", DEFAULT_COUNT));
const start = Number(getArgValue("--start", DEFAULT_START));
const gradeLevel = getArgValue("--grade", DEFAULT_GRADE_LEVEL);
const schoolId = getArgValue("--school-id", "");
const schoolCode = getArgValue("--school-code", DEFAULT_SCHOOL_CODE);
const schoolName = getArgValue("--school-name", "");
const outputPath = getArgValue("--out", "bulk-student-credentials.csv");

const credentials = [];

const normalizeUserId = (index) => `testuser${String(index).padStart(2, "0")}`;
const normalizePassword = (index) => `Password@${String(index).padStart(2, "0")}`;

const buildSecurityQuestions = async (index) => {
  const rawAnswers = [
    `teacher${index}`,
    `subject${index}`,
    `mother${index}`,
    `pet${index}`,
    `food${index}`,
  ];

  return Promise.all(
    DEFAULT_SECURITY_QUESTIONS.map(async (question, questionIndex) => ({
      question,
      answerHash: await bcrypt.hash(rawAnswers[questionIndex], 10),
    })),
  );
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

  return School.findOne({ status: "active" }).sort({ totalStudent: -1, createdAt: 1 });
};

const syncSchoolCounts = async (school) => {
  const totalStudent = await Student.countDocuments({ school: school._id });
  await School.findByIdAndUpdate(school._id, { totalStudent });
};

try {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("count must be a positive integer");
  }
  if (!Number.isInteger(start) || start <= 0) {
    throw new Error("start must be a positive integer");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const school = await findSchool();
  if (!school) {
    throw new Error("No school found for bulk student creation");
  }

  for (let index = start; index < start + count; index += 1) {
    const userId = normalizeUserId(index);
    const password = normalizePassword(index);
    const studentName = `Test User ${String(index).padStart(2, "0")}`;
    const securityQuestions = await buildSecurityQuestions(index);

    let user = await User.findOne({ userId: userId.toUpperCase() }).select("+password");
    if (!user) {
      user = await User.create({
        name: studentName,
        userId,
        password,
        role: "student",
        school: school._id,
        gradeLevel,
        status: DEFAULT_STATUS,
      });
      user = await User.findById(user._id).select("+password");
    } else {
      user.name = studentName;
      user.password = password;
      user.role = "student";
      user.school = school._id;
      user.gradeLevel = gradeLevel;
      user.status = DEFAULT_STATUS;
      await user.save();
    }

    let student = await Student.findOne({ user: user._id });
    if (!student) {
      student = await Student.create({
        user: user._id,
        school: school._id,
        name: studentName,
        gradeLevel,
        status: DEFAULT_STATUS,
        securityQuestions,
      });
    } else {
      student.school = school._id;
      student.name = studentName;
      student.gradeLevel = gradeLevel;
      student.status = DEFAULT_STATUS;
      student.securityQuestions = securityQuestions;
      await student.save();
    }

    credentials.push({
      userId,
      password,
      schoolName: school.name,
      schoolCode: school.schoolCode,
      gradeLevel,
      userDbId: String(user._id),
      studentDbId: String(student._id),
    });
  }

  await syncSchoolCounts(school);

  const lines = [
    "userId,password,schoolName,schoolCode,gradeLevel,userDbId,studentDbId",
    ...credentials.map((item) =>
      [
        item.userId,
        item.password,
        `"${item.schoolName.replace(/"/g, '""')}"`,
        item.schoolCode,
        item.gradeLevel,
        item.userDbId,
        item.studentDbId,
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
        range: {
          start,
          end: start + count - 1,
        },
        gradeLevel,
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
