const nodemailer = require('nodemailer');

function getTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

const FROM = process.env.SMTP_FROM || '"Skooly Admissions" <admissions@skoolyplus.com>';

function applicationApprovedHTML({ applicantName, schoolName, applicationType }) {
    const typeLabel = applicationType === 'ADMISSION_APPLICATION' ? 'Student Admission' : 'Staff Employment';
    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#1a2fa0;padding:24px 32px">
        <h2 style="color:#fff;margin:0">${schoolName}</h2>
        <p style="color:#bfdbfe;margin:4px 0 0">Application Update</p>
      </div>
      <div style="padding:32px">
        <p>Dear <strong>${applicantName}</strong>,</p>
        <p>Congratulations! Your application for <strong>${typeLabel}</strong> has been <strong>approved</strong>.</p>
        <p>The school administration will contact you shortly regarding the next steps for your enrollment or onboarding process.</p>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent via Skooly Plus</div>
    </div>`;
}

async function sendApplicationApprovedEmail(to, data) {
    if (!to || !process.env.SMTP_USER) return;
    try {
        const transporter = getTransporter();
        await transporter.sendMail({
            from: FROM,
            to,
            subject: `Application Approved – ${data.schoolName}`,
            html: applicationApprovedHTML(data),
        });
    } catch (err) {
        console.error('[Application Email] sendApplicationApprovedEmail failed:', err.message);
    }
}

module.exports = {
    sendApplicationApprovedEmail,
};
