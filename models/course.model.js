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

const courseSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    slug: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    gradeLevels: [
      {
        type: String,
        enum: ["JHS 1", "JHS 2", "JHS 3"],
        set: normalizeGradeLevel,
      },
    ],
    image: {
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
  { timestamps: true },
);

courseSchema.pre("validate", function preValidate(next) {
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  next();
});

export const Course = model("Course", courseSchema);
