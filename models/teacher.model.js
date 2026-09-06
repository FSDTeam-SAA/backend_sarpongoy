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

const teacherSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
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
    bio: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    gradeLevel: {
      type: String,
      enum: ["JHS 1", "JHS 2", "JHS 3"],
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

teacherSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate();

  if (update.firstName || update.lastName) {
    const firstName = update.firstName || "";
    const lastName = update.lastName || "";
    update.name = `${firstName} ${lastName}`.trim();
  }

  next();
});

export const Teacher = model("Teacher", teacherSchema);
