const { getTransporter, getFromEmail } = require('../utils/emailTransporter');

const FROM = process.env.SMTP_FROM || '"Skooly Plus" <support@skoolyplus.com>';

function passwordResetHTML({ resetLink }) {
    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#060b17;padding:24px 32px">
        <h2 style="color:#fff;margin:0">Skooly Plus Admin</h2>
      </div>
      <div style="padding:32px">
        <p>You requested a password reset for your Central Admin account.</p>
        <p>Click the button below to set a new password. This link is valid for 1 hour.</p>
        <div style="margin:24px 0;">
            <a href="${resetLink}" style="background-color:#3b82f6;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">Reset Password</a>
        </div>
        <p style="font-size:12px;color:#64748b;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent via Skooly Plus</div>
    </div>`;
}

async function sendAdminPasswordResetEmail(to, resetLink) {
    if (!to || !process.env.SMTP_USER) {
        console.log('\n======================================================');
        console.log(`[Email Fallback] Password Reset requested for ${to}`);
        console.log(`Link: ${resetLink}`);
        console.log('======================================================\n');
        return;
    }
    
    try {
        const transporter = await getTransporter();
        const from = await getFromEmail();
        await transporter.sendMail({
            from,
            to,
            subject: 'Skooly Plus Admin - Password Reset',
            html: passwordResetHTML({ resetLink }),
        });
        console.log(`[Email Service] Sent reset link to ${to}`);
    } catch (err) {
        console.error('[Application Email] sendAdminPasswordResetEmail failed:', err.message);
        // Fallback for local development
        console.log('\n======================================================');
        console.log(`[Email Fallback] Password Reset requested for ${to}`);
        console.log(`Link: ${resetLink}`);
        console.log('======================================================\n');
    }
}

module.exports = {
    sendAdminPasswordResetEmail,
};
