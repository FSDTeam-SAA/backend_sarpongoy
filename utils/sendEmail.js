import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.EMAIL_PORT || 587),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS,
  },
});

export const sendEmail = async (to, subject, html) => {
  if (!process.env.EMAIL_USER || !(process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS)) {
    // Non-blocking fallback for local development when SMTP credentials are not configured.
    console.log("Email skipped: missing SMTP credentials", { to, subject });
    return;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to,
    subject: subject || "Password change link",
    html,
  });
};

export const sendMessageTemplate = ({ email, name, phone, message }) => {
  return `
    <div style="font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;max-width:650px;margin:auto;border:1px solid #e5e7eb;padding:30px;border-radius:12px;background-color:#ffffff;">
      <header style="text-align:center;padding-bottom:20px;border-bottom:1px solid #e5e7eb;">
        <h1 style="color:#0f172a;margin:0;">Hello Admin</h1>
        <p style="font-size:14px;color:#6b7280;margin-top:4px;">New Support Message</p>
      </header>
      <section style="padding:25px 0;">
        <p><strong>Sender Email:</strong> ${email}</p>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Phone:</strong> ${phone || "N/A"}</p>
        <div style="margin-top:20px;padding:20px;background-color:#f9fafb;border-left:4px solid #1d4ed8;border-radius:8px;">
          <p style="white-space:pre-wrap;">${message}</p>
        </div>
      </section>
    </div>
  `;
};

export const inviteLinkTemplate = (inviterName, inviteLink) => {
  return `
    <div style="font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;max-width:650px;margin:auto;border-radius:14px;overflow:hidden;background-color:#f9fafb;">
      <div style="background:linear-gradient(135deg,#4f46e5,#3b82f6);padding:30px;text-align:center;color:white;">
        <h1 style="margin:0;font-size:26px;font-weight:bold;">You are invited</h1>
        <p style="margin-top:6px;font-size:15px;opacity:0.9;">${inviterName} has invited you</p>
      </div>
      <div style="padding:30px;background-color:#ffffff;">
        <p>Click below to accept your invitation.</p>
        <div style="text-align:center;margin:30px 0;">
          <a href="${inviteLink}" target="_blank" style="display:inline-block;padding:14px 28px;background-color:#3b82f6;color:#ffffff;border-radius:8px;text-decoration:none;">Accept Invitation</a>
        </div>
      </div>
    </div>
  `;
};
