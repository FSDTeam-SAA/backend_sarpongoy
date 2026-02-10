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
    lesson: {
      type: Schema.Types.ObjectId,
      ref: "Lesson",
      required: true,
      index: true,
    },
    activityType: {
      type: String,
      enum: ["get_ready", "learn", "practice", "quiz", "resource"],
      required: true,
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
    activityMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    completedAt: { type: Date },
    performedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

progressSchema.index(
  { student: 1, lesson: 1, activityType: 1 },
  { unique: true },
);

export const Progress = model("Progress", progressSchema);
