import { Schema, model } from "mongoose";

const supportTicketSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["student", "teacher", "admin"],
      required: true,
      index: true,
    },
    userId: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: ["open", "in_review", "resolved"],
      default: "open",
      index: true,
    },
    resolutionNote: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

export const SupportTicket = model("SupportTicket", supportTicketSchema);
