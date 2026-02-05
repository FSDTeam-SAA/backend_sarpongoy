import { Schema, model } from "mongoose";

const schoolSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    schooleCode: {
      type: String,
      required: true,
    },
    totalStudent: {
      type: Number,
      default: 0,
    },
    totalTeacher: {
      type: Number,
      default: 0,
    },
    gradeLevel: {
      type: String,
      enum: ["JHS 1", "JHS 2", "JHS 3", "SS 1", "SS 2", "SS 3", "SS 4", "SS 5"],
    },
  },
  { timestamps: true },
);

export const School = model("School", schoolSchema);
