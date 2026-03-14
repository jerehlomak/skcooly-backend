const { Queue, Worker } = require('bullmq');
const { redis } = require('./redis.service');
const prisma = require('../db/prisma');

let smsQueue = null;
let smsWorker = null;

const initSmsWorker = () => {
    if (!redis) {
        console.warn('[BullMQ] Redis is disabled locally. Skipping SMS Worker initialization.');
        return;
    }

    // 1. Initialize the Queue
    smsQueue = new Queue('sms-dispatch-queue', { connection: redis });

    // 2. Initialize the Worker
    smsWorker = new Worker('sms-dispatch-queue', async (job) => {
        const { schoolId, category, message, recipientGroups, sentBy } = job.data;
        console.log(`[SMS Worker] Processing batch for School ${schoolId}...`);

        let totalCount = 0;
        const resolvedGroups = [];

        // Resolve recipient counts from live DB to ensure data accuracy at time of flight
        for (const groupId of recipientGroups) {
            let count = 0;
            if (groupId === 'all-parents') {
                count = await prisma.parentProfile.count({ where: { schoolId } });
            } else if (groupId === 'all-students') {
                count = await prisma.studentProfile.count({ where: { status: 'Active', schoolId } });
            } else if (groupId === 'all-teachers') {
                count = await prisma.teacherProfile.count({ where: { status: 'Active', schoolId } });
            } else if (groupId === 'all') {
                const [p, s, t] = await Promise.all([
                    prisma.parentProfile.count({ where: { schoolId } }),
                    prisma.studentProfile.count({ where: { status: 'Active', schoolId } }),
                    prisma.teacherProfile.count({ where: { status: 'Active', schoolId } }),
                ]);
                count = p + s + t;
            } else {
                // Class-level logic
                const classLevel = groupId.toUpperCase().replace('-', ' ');
                count = await prisma.studentProfile.count({ where: { classLevel: { contains: classLevel, mode: 'insensitive' }, schoolId } });
            }
            totalCount += count;
            resolvedGroups.push(groupId);
        }

        if (totalCount === 0) {
            console.log(`[SMS Worker] 0 recipients resolved for groups: ${recipientGroups.join(', ')}. Skipping.`);
            return;
        }

        // TODO: In production, integrate actual SMS gateway (Termii, Twilio, etc.) here
        // await externalSmsProvider.send({...})

        // Log completion
        await prisma.smsLog.create({
            data: {
                schoolId,
                category: category || 'Custom',
                message,
                recipientGroup: resolvedGroups.join(', '),
                recipientCount: totalCount,
                sentBy,
                status: 'DELIVERED',
            }
        });

        console.log(`[SMS Worker] Successfully dispatched and logged ${totalCount} messages.`);
    }, { connection: redis });

    smsWorker.on('failed', (job, err) => {
        console.error(`[SMS Worker] Job ${job?.id} failed:`, err.message);
    });
};

const getSmsQueue = () => smsQueue;

module.exports = { initSmsWorker, getSmsQueue };
