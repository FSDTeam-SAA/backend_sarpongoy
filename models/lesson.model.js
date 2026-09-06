import { Schema, model } from "mongoose";

const normalizeGradeLevel = (value) => {
  if (!value) return value;
  const compact = String(value).trim().toUpperCase().replace(/\s+/g, "");
  const map = {
    JHS1: "JHS 1",
    JHS2: "JHS 2",
    JHS3: "JHS 3",
  };
  return map[compact] || value;
};

const lessonSchema = new Schema(
  {
    course: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    gradeLevel: {
      type: String,
      enum: ["JHS 1", "JHS 2", "JHS 3"],
      set: normalizeGradeLevel,
      required: true,
      index: true,
    },
    strand: {
      type: String,
      required: true,
      trim: true,
    },
    subStrand: {
      type: String,
      required: true,
      trim: true,
    },
    lessonNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    estimatedMinutes: {
      type: Number,
      default: 30,
      min: 1,
    },
    resources: [
      {
        title: { type: String, trim: true },
        type: {
          type: String,
          enum: ["pdf", "video", "url", "document", "other"],
          default: "other",
        },
        link: { type: String, trim: true },
      },
    ],
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true },
);

lessonSchema.index(
  { course: 1, gradeLevel: 1, strand: 1, subStrand: 1, lessonNumber: 1 },
  { unique: true },
);

export const Lesson = model("Lesson", lessonSchema);
