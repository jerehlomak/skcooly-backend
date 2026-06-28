const { getTransporter, getFromEmail } = require('../utils/emailTransporter');

function applicationApprovedHTML({ applicantName, schoolName, applicationType, interviewDate, interviewTime, interviewLocation }) {
    const typeLabel = applicationType === 'ADMISSION_APPLICATION' ? 'Student Admission' : 'Staff Employment';
    
    let interviewBlock = '';
    if (interviewDate || interviewTime || interviewLocation) {
        interviewBlock = `
        <div style="background:#f1f5f9;border-left:4px solid #1a2fa0;padding:16px;margin:24px 0;border-radius:4px;">
            <h3 style="margin-top:0;color:#1e293b;font-size:16px;">Interview Scheduled</h3>
            <p style="margin:4px 0;color:#334155;"><strong>Date:</strong> ${interviewDate || 'TBD'}</p>
            <p style="margin:4px 0;color:#334155;"><strong>Time:</strong> ${interviewTime || 'TBD'}</p>
            <p style="margin:4px 0;color:#334155;"><strong>Location:</strong> ${interviewLocation || 'TBD'}</p>
        </div>`;
    }

    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#1a2fa0;padding:24px 32px">
        <h2 style="color:#fff;margin:0">${schoolName}</h2>
        <p style="color:#bfdbfe;margin:4px 0 0">Application Update</p>
      </div>
      <div style="padding:32px">
        <p>Dear <strong>${applicantName}</strong>,</p>
        <p>Congratulations! Your application for <strong>${typeLabel}</strong> has been <strong>approved</strong>.</p>
        ${interviewBlock}
        <p>You can also log in to the application portal to check your status and view these details.</p>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent via Skooly Plus</div>
    </div>`;
}

async function sendApplicationApprovedEmail(to, data) {
    if (!to) return;
    try {
        const transporter = await getTransporter(data.schoolId);
        const from = await getFromEmail(data.schoolId);
        
        await transporter.sendMail({
            from,
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
