const nodemailer = require('nodemailer');
const { decrypt } = require('./encryption');
const prisma = require('../db/prisma');

// Pooled connections avoid paying a fresh TCP+TLS+SMTP-handshake cost on every single email,
// and bounded timeouts stop a slow/unresponsive SMTP host from hanging a request indefinitely.
const SMTP_PERF_OPTS = {
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
};

async function getTransporter(schoolId) {
    if (schoolId) {
        try {
            const settings = await prisma.schoolSettings.findFirst({
                where: { schoolId }
            });

            if (settings && settings.smtpHost && settings.smtpUser && settings.smtpPass) {
                return nodemailer.createTransport({
                    host: settings.smtpHost,
                    port: Number(settings.smtpPort) || 587,
                    secure: Number(settings.smtpPort) === 465,
                    auth: {
                        user: settings.smtpUser,
                        pass: decrypt(settings.smtpPass),
                    },
                    ...SMTP_PERF_OPTS,
                });
            }
        } catch (err) {
            console.error('[emailTransporter] Error fetching school SMTP:', err.message);
        }
    }

    // Fallback to global SaaS SMTP
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
        ...SMTP_PERF_OPTS,
    });
}

async function getFromEmail(schoolId) {
    if (schoolId) {
        try {
            const settings = await prisma.schoolSettings.findFirst({
                where: { schoolId }
            });
            if (settings && settings.smtpFrom) {
                return settings.smtpFrom;
            }
        } catch (err) {}
    }
    return process.env.SMTP_FROM || '"Skooly SaaS" <noreply@skoolyplus.com>';
}

module.exports = { getTransporter, getFromEmail };
