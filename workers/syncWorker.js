import { Worker } from "bullmq";
import { redisConnection } from "../config/queue.js";
import { Lesson } from "../models/lesson.model.js";
import { Course } from "../models/course.model.js";
import { Progress } from "../models/progress.model.js";
import { Student } from "../models/student.model.js";
import mongoose from "mongoose";
import { normalizeGradeLevel } from "../utils/grade.js";

const processSyncJob = async (job) => {
  const { studentId, activities, topLevelGrade } = job.data;

  console.log(`[Worker] Processing sync job for student: ${studentId} (${activities.length} items)`);

  try {
    const student = await Student.findById(studentId).lean();
    if (!student) throw new Error("Student not found");

    // --- Step 1: Pre-fetch Data ---
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

    // --- Step 2: Build Operations ---
    for (let idx = 0; idx < activities.length; idx += 1) {
      const item = activities[idx] || {};
      const lessonId = item.lesson_id || item.lessonId || item.lesson;
      const activityType = String(item.activity_type || item.activityType || "").trim().toLowerCase();

      if (!lessonId || !activityType) continue;

      let lessonDoc = mongoose.Types.ObjectId.isValid(lessonId) ? lessonMap.get(String(lessonId)) : null;
      let courseDoc = item.course_name ? courseMap.get(String(item.course_name).toLowerCase().trim()) : null;

      // Fallback: Create Course if missing
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

      if (!lessonDoc) continue;

      if (!courseDoc) {
        courseDoc = await Course.findById(lessonDoc.course).lean();
      }

      const status = (Number(item.is_completed) === 1 || item.is_completed === true) ? "completed" : "in_progress";
      const incomingLastUpdated = item.last_updated ? new Date(item.last_updated) : new Date();

      const progressKey = `${lessonDoc._id}_${activityType}_${item.sub_activity || null}`;
      const existingRecord = progressMap.get(progressKey);

      if (existingRecord && new Date(existingRecord.lastUpdated) > incomingLastUpdated) {
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
        score: parseScore(item.score),
        activityMinutes: Number(item.activity_minutes || item.activityMinutes || 0),
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

      progressMap.set(progressKey, { lastUpdated: incomingLastUpdated });
    }

    // --- Step 3: Execute Bulk Write ---
    if (bulkOps.length > 0) {
      await Progress.bulkWrite(bulkOps, { ordered: false });
      console.log(`[Worker] Successfully synced ${bulkOps.length} activities for student ${studentId}`);
    }
  } catch (error) {
    console.error(`[Worker] Error processing sync job for student ${studentId}:`, error);
    throw error; // Re-throw to allow BullMQ to retry
  }
};

// Initialize the Worker
export const activitySyncWorker = new Worker("activity-sync-queue", processSyncJob, {
  connection: redisConnection,
  concurrency: 5, // Process up to 5 jobs at once
});

activitySyncWorker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed successfully`);
});

activitySyncWorker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job.id} failed with error: ${err.message}`);
});

console.log("🚀 Activity Sync Worker started");
