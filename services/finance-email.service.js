/**
 * Finance Email Service
 * Uses nodemailer to send transactional finance emails.
 * Reads SMTP credentials from environment variables.
 */
const { getTransporter, getFromEmail } = require('../utils/emailTransporter');

// ─── EMAIL TEMPLATES ────────────────────────────────────────────────────────

function invoiceIssuedHTML({ studentName, invoiceNumber, totalAmount, dueDate, items, showItemizedBreakdown, schoolName, currencySymbol }) {
    let itemsHTML = '';
    if (showItemizedBreakdown && items && items.length > 0) {
        itemsHTML = `
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;border:1px solid #e2e8f0;border-radius:8px;">
          <tr style="background:#f8fafc">
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e2e8f0">Description</th>
            <th style="padding:8px;text-align:right;border-bottom:1px solid #e2e8f0">Amount</th>
          </tr>
          ${items.map(item => `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #f1f5f9">${item.label}</td>
            <td style="padding:8px;text-align:right;border-bottom:1px solid #f1f5f9">${currencySymbol}${Number(item.amount).toLocaleString()}</td>
          </tr>
          `).join('')}
          <tr style="background:#f8fafc">
            <td style="padding:8px;font-weight:bold;text-align:right">Total Due</td>
            <td style="padding:8px;font-weight:bold;text-align:right;color:#1e40af">${currencySymbol}${Number(totalAmount).toLocaleString()}</td>
          </tr>
        </table>
        `;
    } else {
        itemsHTML = `
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;color:#64748b">Invoice Number</td><td style="padding:8px;font-weight:600">${invoiceNumber}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px;color:#64748b">Amount Due</td><td style="padding:8px;font-weight:600;color:#1e40af">${currencySymbol}${Number(totalAmount).toLocaleString()}</td></tr>
          <tr><td style="padding:8px;color:#64748b">Due Date</td><td style="padding:8px">${dueDate ? new Date(dueDate).toLocaleDateString() : 'N/A'}</td></tr>
        </table>
        `;
    }

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
        
        ${itemsHTML}
        
        ${showItemizedBreakdown ? `<p style="margin-top:16px;font-size:14px;color:#64748b"><strong>Due Date:</strong> ${dueDate ? new Date(dueDate).toLocaleDateString() : 'N/A'} &nbsp;|&nbsp; <strong>Invoice #:</strong> ${invoiceNumber}</p>` : ''}
        <p style="color:#64748b;font-size:14px">Please contact the school finance office for payment options.</p>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8">Sent by Skooly Finance System</div>
    </div>`;
}

function familyStatementHTML(data) {
    let childrenHTML = '';
    data.childrenData.forEach(child => {
        childrenHTML += `
            <div style="margin-top: 20px; padding-top: 15px; border-top: 2px solid #e2e8f0;">
                <h3 style="margin: 0 0 10px 0; color: #1e40af;">Student: ${child.name}</h3>
        `;
        if (data.showItemizedBreakdown) {
            // Show itemized breakdown per child
            childrenHTML += `
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                    <tr style="background-color: #f8fafc;">
                        <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">Description</th>
                        <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">Amount</th>
                    </tr>
            `;
            let childBalance = 0;
            child.invoices.forEach(inv => {
                childBalance += inv.balanceDue;
                (inv.items || []).forEach(item => {
                    childrenHTML += `
                        <tr>
                            <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; color: #475569;">${item.label}</td>
                            <td style="padding: 8px; text-align: right; border-bottom: 1px solid #f1f5f9; color: #475569;">${data.currencySymbol}${Number(item.amount).toLocaleString()}</td>
                        </tr>
                    `;
                });
            });
            childrenHTML += `
                    <tr style="background-color: #f8fafc;">
                        <td style="padding: 8px; font-weight: bold; text-align: right;">Child Balance Due:</td>
                        <td style="padding: 8px; font-weight: bold; text-align: right; color: #dc2626;">${data.currencySymbol}${Number(childBalance).toLocaleString()}</td>
                    </tr>
                </table></div>
            `;
        } else {
            // Show consolidated invoice lines
            childrenHTML += `
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                    <tr style="background-color: #f8fafc;">
                        <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">Invoice #</th>
                        <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">Total</th>
                        <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">Balance Due</th>
                    </tr>
            `;
            child.invoices.forEach(inv => {
                childrenHTML += `
                        <tr>
                            <td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">${inv.invoiceNumber}</td>
                            <td style="padding: 8px; text-align: right; border-bottom: 1px solid #f1f5f9;">${data.currencySymbol}${Number(inv.totalAmount).toLocaleString()}</td>
                            <td style="padding: 8px; text-align: right; border-bottom: 1px solid #f1f5f9; color: ${inv.balanceDue > 0 ? '#dc2626' : '#15803d'}; font-weight: bold;">${data.currencySymbol}${Number(inv.balanceDue).toLocaleString()}</td>
                        </tr>
                `;
            });
            childrenHTML += `</table></div>`;
        }
    });

    return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#1e40af;padding:24px 32px">
        <h2 style="color:#fff;margin:0">${data.schoolName}</h2>
        <p style="color:#bfdbfe;margin:4px 0 0">Family Billing Statement</p>
      </div>
      <div style="padding:32px">
        <p>Dear <strong>${data.parentName}</strong>,</p>
        <p>This is a consolidated statement of the school fees for your children for ${data.term ? data.term.replace(/_/g, ' ') : 'this term'} ${data.academicYear || ''}.</p>
        
        ${childrenHTML}

        <div style="margin-top: 30px; padding: 20px; background-color: #f8fafc; border-radius: 8px; text-align: center;">
            <p style="margin: 0 0 5px 0; font-size: 14px; color: #64748b; text-transform: uppercase; font-weight: bold;">Total Family Balance</p>
            <p style="margin: 0; font-size: 24px; color: #dc2626; font-weight: bold;">${data.currencySymbol}${Number(data.grandBalance).toLocaleString()}</p>
        </div>
        <p style="color:#64748b;font-size:14px;margin-top:20px;">Please login to the parent portal to view detailed itemized breakdowns or make payments.</p>
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

async function sendInvoiceIssuedEmail(to, data) {
    if (!to) return;
    try {
        const transporter = await getTransporter(data.schoolId);
        const from = await getFromEmail(data.schoolId);
        await transporter.sendMail({
            from,
            to,
            subject: `Invoice #${data.invoiceNumber} - ${data.schoolName}`,
            html: invoiceIssuedHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendInvoiceIssuedEmail failed:', err.message);
    }
}

async function sendPaymentReceiptEmail(to, data) {
    if (!to) return;
    try {
        const transporter = await getTransporter(data.schoolId);
        const from = await getFromEmail(data.schoolId);
        await transporter.sendMail({
            from,
            to,
            subject: `Payment Receipt - ${data.schoolName}`,
            html: receiptHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendPaymentReceiptEmail failed:', err.message);
    }
}

async function sendTransferSubmittedEmail(to, data) {
    if (!to) return;
    try {
        const transporter = await getTransporter(data.schoolId);
        const from = await getFromEmail(data.schoolId);
        await transporter.sendMail({
            from,
            to,
            subject: `Transfer Submission Received – ${data.schoolName}`,
            html: transferSubmittedHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendTransferSubmittedEmail failed:', err.message);
    }
}

async function sendTransferApprovedEmail(to, data) {
    if (!to) return;
    try {
        const transporter = await getTransporter(data.schoolId);
        const from = await getFromEmail(data.schoolId);
        await transporter.sendMail({
            from,
            to,
            subject: `Transfer Approved – ${data.schoolName}`,
            html: transferApprovedHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendTransferApprovedEmail failed:', err.message);
    }
}

async function sendTransferRejectedEmail(to, data) {
    if (!to) return;
    try {
        const transporter = await getTransporter(data.schoolId);
        const from = await getFromEmail(data.schoolId);
        await transporter.sendMail({
            from,
            to,
            subject: `Transfer Not Confirmed – ${data.schoolName}`,
            html: transferRejectedHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendTransferRejectedEmail failed:', err.message);
    }
}

async function sendFamilyStatementEmail(to, data) {
    if (!to) return;
    try {
        const transporter = await getTransporter(data.schoolId);
        const from = await getFromEmail(data.schoolId);
        await transporter.sendMail({
            from,
            to,
            subject: `Family Statement of Account - ${data.schoolName}`,
            html: familyStatementHTML(data),
        });
    } catch (err) {
        console.error('[Finance Email] sendFamilyStatementEmail failed:', err.message);
    }
}

module.exports = {
    sendInvoiceEmail: sendInvoiceIssuedEmail,
    sendReceiptEmail: sendPaymentReceiptEmail,
    sendTransferSubmittedEmail,
    sendTransferApprovedEmail,
    sendTransferRejectedEmail,
    sendFamilyStatementEmail,
};
