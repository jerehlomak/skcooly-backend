/**
 * Finance Email Service
 * Uses nodemailer to send transactional finance emails.
 * Reads SMTP credentials from environment variables.
 */
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

const FROM = process.env.SMTP_FROM || '"Skooly Finance" <finance@skooly.app>';

// ─── EMAIL TEMPLATES ────────────────────────────────────────────────────────

function invoiceIssuedHTML({ studentName, invoiceNumber, totalAmount, dueDate, schoolName, currencySymbol }) {
    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#1e40af;padding:24px 32px">
        <h2 style="color:#fff;margin:0">${schoolName}</h2>
        <p style="color:#bfdbfe;margin:4px 0 0">Finance Department</p>
      </div>
      <div style="padding:32px">
        <h3 style="color:#1e293b">Invoice Issued</h3>
        <p>Dear <strong>${studentName}</strong>,</p>
        <p>An invoice has been generated for your account.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;color:#64748b">Invoice Number</td><td style="padding:8px;font-weight:600">${invoiceNumber}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px;color:#64748b">Amount Due</td><td style="padding:8px;font-weight:600;color:#1e40af">${currencySymbol}${Number(totalAmount).toLocaleString()}</td></tr>
          <tr><td style="padding:8px;color:#64748b">Due Date</td><td style="padding:8px">${dueDate ? new Date(dueDate).toLocaleDateString() : 'N/A'}</td></tr>
        </table>
        <p style="color:#64748b;font-size:14px">Please contact the school finance office for payment options.</p>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent by Skooly Finance System</div>
    </div>`;
}

function receiptHTML({ studentName, receiptNumber, amountPaid, paymentMethod, invoiceNumber, schoolName, currencySymbol, walletBalanceAfter }) {
    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#15803d;padding:24px 32px">
        <h2 style="color:#fff;margin:0">${schoolName} – Payment Receipt</h2>
      </div>
      <div style="padding:32px">
        <p>Dear <strong>${studentName}</strong>,</p>
        <p>Your payment has been confirmed. Thank you!</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;color:#64748b">Receipt No.</td><td style="padding:8px;font-weight:600">${receiptNumber}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px;color:#64748b">Amount Paid</td><td style="padding:8px;font-weight:600;color:#15803d">${currencySymbol}${Number(amountPaid).toLocaleString()}</td></tr>
          <tr><td style="padding:8px;color:#64748b">Payment Method</td><td style="padding:8px">${paymentMethod}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px;color:#64748b">Invoice</td><td style="padding:8px">${invoiceNumber}</td></tr>
          ${walletBalanceAfter != null ? `<tr><td style="padding:8px;color:#64748b">Wallet Balance</td><td style="padding:8px">${currencySymbol}${Number(walletBalanceAfter).toLocaleString()}</td></tr>` : ''}
        </table>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent by Skooly Finance System</div>
    </div>`;
}

function transferSubmittedHTML({ studentName, amount, schoolName, currencySymbol }) {
    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#7c3aed;padding:24px 32px">
        <h2 style="color:#fff;margin:0">${schoolName} – Transfer Received</h2>
      </div>
      <div style="padding:32px">
        <p>Dear <strong>${studentName}</strong>,</p>
        <p>We have received your bank transfer submission of <strong>${currencySymbol}${Number(amount).toLocaleString()}</strong>.</p>
        <p>Our finance team will verify and confirm your payment within 1–2 business days. You will receive a receipt once approved.</p>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent by Skooly Finance System</div>
    </div>`;
}

function transferApprovedHTML({ studentName, amount, schoolName, currencySymbol }) {
    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#15803d;padding:24px 32px">
        <h2 style="color:#fff;margin:0">${schoolName} – Transfer Approved</h2>
      </div>
      <div style="padding:32px">
        <p>Dear <strong>${studentName}</strong>,</p>
        <p>Your bank transfer of <strong>${currencySymbol}${Number(amount).toLocaleString()}</strong> has been <strong>approved</strong> and applied to your account.</p>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent by Skooly Finance System</div>
    </div>`;
}

function transferRejectedHTML({ studentName, amount, schoolName, currencySymbol, reason }) {
    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#dc2626;padding:24px 32px">
        <h2 style="color:#fff;margin:0">${schoolName} – Transfer Rejected</h2>
      </div>
      <div style="padding:32px">
        <p>Dear <strong>${studentName}</strong>,</p>
        <p>Unfortunately, your transfer submission of <strong>${currencySymbol}${Number(amount).toLocaleString()}</strong> could not be confirmed.</p>
        ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
        <p>Please contact the finance office or resubmit with correct details.</p>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent by Skooly Finance System</div>
    </div>`;
}

// ─── SEND HELPERS ───────────────────────────────────────────────────────────

async function sendInvoiceEmail(to, data) {
    if (!to || !process.env.SMTP_USER) return; // skip if no email configured
    try {
        const transporter = getTransporter();
        await transporter.sendMail({
            from: FROM,
            to,
            subject: `Invoice ${data.invoiceNumber} – ${data.schoolName}`,
            html: invoiceIssuedHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendInvoiceEmail failed:', err.message);
    }
}

async function sendReceiptEmail(to, data) {
    if (!to || !process.env.SMTP_USER) return;
    try {
        const transporter = getTransporter();
        await transporter.sendMail({
            from: FROM,
            to,
            subject: `Payment Receipt ${data.receiptNumber} – ${data.schoolName}`,
            html: receiptHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendReceiptEmail failed:', err.message);
    }
}

async function sendTransferSubmittedEmail(to, data) {
    if (!to || !process.env.SMTP_USER) return;
    try {
        const transporter = getTransporter();
        await transporter.sendMail({
            from: FROM,
            to,
            subject: `Transfer Submission Received – ${data.schoolName}`,
            html: transferSubmittedHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendTransferSubmittedEmail failed:', err.message);
    }
}

async function sendTransferApprovedEmail(to, data) {
    if (!to || !process.env.SMTP_USER) return;
    try {
        const transporter = getTransporter();
        await transporter.sendMail({
            from: FROM,
            to,
            subject: `Transfer Approved – ${data.schoolName}`,
            html: transferApprovedHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendTransferApprovedEmail failed:', err.message);
    }
}

async function sendTransferRejectedEmail(to, data) {
    if (!to || !process.env.SMTP_USER) return;
    try {
        const transporter = getTransporter();
        await transporter.sendMail({
            from: FROM,
            to,
            subject: `Transfer Not Confirmed – ${data.schoolName}`,
            html: transferRejectedHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendTransferRejectedEmail failed:', err.message);
    }
}

module.exports = {
    sendInvoiceEmail,
    sendReceiptEmail,
    sendTransferSubmittedEmail,
    sendTransferApprovedEmail,
    sendTransferRejectedEmail,
};
