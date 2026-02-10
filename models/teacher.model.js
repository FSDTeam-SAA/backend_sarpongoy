import { Schema, model } from "mongoose";

const normalizeGradeLevel = (value) => {
  if (!value) return value;
  const compact = String(value).trim().toUpperCase().replace(/\s+/g, "");
  const map = {
    JHS1: "JHS 1",
    JHS2: "JHS 2",
    JHS3: "JHS 3",
    SS1: "SS 1",
    SS2: "SS 2",
    SS3: "SS 3",
    SS4: "SS 4",
    SS5: "SS 5",
  };
  return map[compact] || value;
};

const teacherSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    school: {
      type: Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    courses: [
      {
        type: Schema.Types.ObjectId,
        ref: "Course",
      },
    ],
    name: {
      type: String,
      required: true,
      trim: true,
    },
    gradeLevel: {
      type: String,
      enum: ["JHS 1", "JHS 2", "JHS 3", "SS 1", "SS 2", "SS 3", "SS 4", "SS 5"],
      set: normalizeGradeLevel,
      required: true,
      index: true,
    },
    picture: {
      public_id: { type: String, default: "" },
      url: { type: String, default: "" },
    },
    file: {
      public_id: { type: String, default: "" },
      url: { type: String, default: "" },
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

export const Teacher = model("Teacher", teacherSchema);
