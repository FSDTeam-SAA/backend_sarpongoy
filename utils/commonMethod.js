import crypto from "crypto";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { v2 as cloudinary } from "cloudinary";
import nodemailer from "nodemailer";

export const generateOTP = () => {
  const OTP_LENGTH = 6;
  return Array.from({ length: OTP_LENGTH }, () => crypto.randomInt(0, 10)).join("");
};

export const generateUniqueId = () => {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `BK${(timestamp + randomPart).slice(0, 8).toUpperCase()}`;
};

export const hashPassword = async (newPassword) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(newPassword, salt);
};

export const uniqueTransactionId = () => {
  return uuidv4().replace(/-/g, "").slice(0, 12).toUpperCase();
};

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.EMAIL_PORT || 587),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS,
  },
});

export const sendOTP = async (email, code) => {
  if (!process.env.EMAIL_USER || !(process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS)) {
    console.log("Email OTP skipped: missing SMTP credentials", { email, code });
    return;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: email,
    subject: "Verification Code",
    text: `Your verification code is: ${code}`,
  });
};

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadOnCloudinary = (fileBuffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ ...options }, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    stream.end(fileBuffer);
  });
};
