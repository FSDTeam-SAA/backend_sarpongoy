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

const schoolSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    schoolCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      index: true,
    },
    // Legacy compatibility with old typo field.
    schooleCode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },
    totalStudent: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalTeacher: {
      type: Number,
      default: 0,
      min: 0,
    },
    gradeLevels: [
      {
        type: String,
        enum: ["JHS 1", "JHS 2", "JHS 3"],
        set: normalizeGradeLevel,
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

schoolSchema.pre("validate", function preValidate(next) {
  if (!this.schoolCode && this.schooleCode) {
    this.schoolCode = this.schooleCode;
  }
  if (!this.schooleCode && this.schoolCode) {
    this.schooleCode = this.schoolCode;
  }
  next();
});

export const School = model("School", schoolSchema);
