import { Schema, model } from "mongoose";

const progressSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    course: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    courseName: {
      type: String,
      trim: true,
    },
    lesson: {
      type: Schema.Types.ObjectId,
      ref: "Lesson",
      required: true,
      index: true,
    },
    lessonId: {
      // client-side lesson identifier to avoid casting errors when offline ids differ
      type: String,
      trim: true,
    },
    strandName: {
      type: String,
      trim: true,
    },
    subStrandName: {
      type: String,
      trim: true,
    },
    lessonNumber: {
      type: String,
      trim: true,
    },
    gradeName: {
      type: String,
      trim: true,
    },
    activityType: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    subActivity: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: ["todo", "in_progress", "completed"],
      default: "todo",
      index: true,
    },
    score: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },
    originalScore: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },
    totalQuestions: {
      type: Number,
      min: 0,
      default: null,
    },
    activityMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    syncStatus: {
      type: Number,
      default: 0,
    },
    lastUpdated: { type: Date },
    completedAt: { type: Date },
    performedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

progressSchema.index(
  { student: 1, lesson: 1, activityType: 1, subActivity: 1 },
  { unique: true },
);

export const Progress = model("Progress", progressSchema);
