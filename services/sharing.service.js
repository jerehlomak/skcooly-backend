const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const nodemailer = require('nodemailer');

// Mock function for sending WhatsApp message
const sendWhatsAppMessage = async (phone, text) => {
    console.log(`[WhatsApp Mock] Sending to ${phone}: ${text}`);
    return true; // Simulate success
};

// Mock function for sending Email (could integrate real nodemailer later)
const sendEmailMessage = async (email, subject, html) => {
    console.log(`[Email Mock] Sending to ${email} | Subject: ${subject}`);
    // Real implementation would use nodemailer
    return true; // Simulate success
};

/**
 * Share a result with a parent
 * @param {string} schoolId 
 * @param {string} studentProfileId 
 * @param {string} term 
 * @param {string} academicYear 
 * @param {string} channel 'EMAIL' | 'WHATSAPP'
 * @param {string} recipient Email address or phone number
 * @param {string} reportCardUrl A link to download/view the report card
 */
const shareResult = async (schoolId, studentProfileId, term, academicYear, channel, recipient, reportCardUrl) => {
    try {
        const student = await prisma.studentProfile.findFirst({
            where: { id: studentProfileId, schoolId },
            include: { user: true }
        });

        if (!student) throw new Error('Student not found');

        let success = false;
        
        if (channel === 'WHATSAPP') {
            const text = `Hello! The ${term} result for ${student.user.name} is now available. View or download it securely here: ${reportCardUrl}`;
            success = await sendWhatsAppMessage(recipient, text);
        } else if (channel === 'EMAIL') {
            const subject = `${student.user.name}'s ${term} Result - Skooly Plus`;
            const html = `
                <h3>Result Notification</h3>
                <p>Dear Parent/Guardian,</p>
                <p>The ${term} (${academicYear}) result for <strong>${student.user.name}</strong> is now available.</p>
                <p><a href="${reportCardUrl}" style="padding: 10px 15px; background-color: #0036a1; color: white; text-decoration: none; border-radius: 5px;">View Report Card</a></p>
                <br />
                <p>Thank you,<br/>School Administration</p>
            `;
            success = await sendEmailMessage(recipient, subject, html);
        }

        // Log the sharing event
        const historyRecord = await prisma.sharingHistory.create({
            data: {
                schoolId,
                studentProfileId,
                term,
                academicYear,
                channel,
                recipient,
                status: success ? 'DELIVERED' : 'FAILED',
                sentAt: new Date()
            }
        });

        return { success, history: historyRecord };
    } catch (error) {
        console.error('Share Result Error:', error);
        
        await prisma.sharingHistory.create({
            data: {
                schoolId,
                studentProfileId,
                term,
                academicYear,
                channel,
                recipient,
                status: 'FAILED',
                sentAt: new Date()
            }
        });

        throw error;
    }
};

module.exports = {
    shareResult
};
