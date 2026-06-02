import mongoose, { Schema } from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new Schema(
  {
    name: { type: String, trim: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    phone: { type: String, trim: true },
    bio: { type: String, trim: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
    },
    password: { type: String, required: true, select: false },
    userId: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["student", "teacher", "admin"],
      default: "admin",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    school: {
      type: Schema.Types.ObjectId,
      ref: "School",
    },
    gradeLevel: {
      type: String,
      enum: ["JHS 1", "JHS 2", "JHS 3", "SS 1", "SS 2", "SS 3", "SS 4", "SS 5"],
    },
    profile: {
      public_id: { type: String, default: "" },
      url: { type: String, default: "" },
    },
    verificationInfo: {
      verified: { type: Boolean, default: false },
      token: { type: String, default: "" },
    },
    password_reset_token: { type: String, default: "" },
    passwordResetOTP: {
      code: { type: String, default: "" },
      expiry: { type: Date },
      verified: { type: Boolean, default: false },
    },
    refreshToken: { type: String, default: "", select: false },
    isEmailVerified: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null, index: true },
    deleteReason: { type: String, default: "" },
  },
  { timestamps: true },
);

userSchema.pre("save", async function userPreSave(next) {
  if (!this.isModified("password")) {
    return next();
  }

  const saltRounds = Number(process.env.bcrypt_salt_round) || 10;
  this.password = await bcrypt.hash(this.password, saltRounds);
  next();
});

userSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate();

  if (update.firstName || update.lastName) {
    const firstName = update.firstName || "";
    const lastName = update.lastName || "";
    update.name = `${firstName} ${lastName}`.trim();
  }

  next();
});

userSchema.statics.isUserExistsByEmail = async function isUserExistsByEmail(
  email,
) {
  return this.findOne({ email }).select("+password");
};

userSchema.statics.isOTPVerified = async function isOTPVerified(id) {
  const user = await this.findById(id).select("+verificationInfo");
  return user?.isEmailVerified;
};

userSchema.statics.isPasswordMatched = async function isPasswordMatched(
  plainTextPassword,
  hashPassword,
) {
  return bcrypt.compare(plainTextPassword, hashPassword);
};

export const User = mongoose.model("User", userSchema);
