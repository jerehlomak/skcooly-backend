const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { getSmsQueue } = require('../services/sms-worker.service');

// ─── INTERNAL MESSAGING ────────────────────────────────────────────────────────

/**
 * Get all messages where sender is current user OR message is addressed to them
 */
const getMessages = async (req, res) => {
    const { userId, name } = req.user;
    const { group } = req.query; // filter by recipientGroup

    const where = group
        ? { recipientGroup: group, schoolId: req.user.schoolId }
        : {
            schoolId: req.user.schoolId,
            OR: [
                { senderId: userId },
                { recipientGroup: 'all' },
                { recipientGroup: req.user.role?.toLowerCase() + 's' }, // teachers / students etc
                { recipientGroup: userId }, // DMs addressed to this user
            ]
        };

    const messages = await prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
    });

    res.status(StatusCodes.OK).json({ messages });
};

/**
 * Get message threads — unique conversations / broadcasts
 */
const getThreads = async (req, res) => {
    const { userId } = req.user;
    const role = req.user.role?.toLowerCase();

    // Pull messages visible to this user
    const messages = await prisma.message.findMany({
        where: {
            schoolId: req.user.schoolId,
            OR: [
                { senderId: userId },
                { recipientGroup: 'all' },
                { recipientGroup: role + 's' },
                { recipientGroup: userId },
            ]
        },
        orderBy: { createdAt: 'desc' },
    });

    // Group into threads by recipientGroup (for broadcasts) or senderId (for DMs)
    const threadMap = new Map();
    for (const msg of messages) {
        const threadKey = msg.senderId === userId
            ? `sent-${msg.recipientGroup}`
            : `${msg.senderId}-${msg.recipientGroup}`;

        if (!threadMap.has(threadKey)) {
            threadMap.set(threadKey, {
                id: threadKey,
                name: msg.senderId === userId ? `To: ${msg.recipientGroup}` : msg.senderName,
                isOwn: msg.senderId === userId,
                recipientGroup: msg.recipientGroup,
                senderId: msg.senderId,
                senderName: msg.senderName,
                lastMessage: msg.body,
                unreadCount: (!msg.isRead && msg.senderId !== userId) ? 1 : 0,
                createdAt: msg.createdAt,
            });
        } else {
            const thread = threadMap.get(threadKey);
            if (!msg.isRead && msg.senderId !== userId) {
                thread.unreadCount++;
            }
        }
    }

    res.status(StatusCodes.OK).json({ threads: Array.from(threadMap.values()) });
};

/**
 * Get a single thread's messages
 */
const getThread = async (req, res) => {
    const { userId } = req.user;
    const { senderId, recipientGroup } = req.query;

    const messages = await prisma.message.findMany({
        where: {
            schoolId: req.user.schoolId,
            senderId: senderId || userId,
            recipientGroup: recipientGroup,
        },
        orderBy: { createdAt: 'asc' },
    });

    // Mark as read
    await prisma.message.updateMany({
        where: {
            schoolId: req.user.schoolId,
            senderId: { not: userId },
            recipientGroup,
            isRead: false,
        },
        data: { isRead: true },
    });

    res.status(StatusCodes.OK).json({ messages });
};

/**
 * Send a message
 */
const sendMessage = async (req, res) => {
    const { userId, name } = req.user;
    const { recipientGroup, subject, body } = req.body;

    if (!recipientGroup || !body?.trim()) {
        throw new CustomError.BadRequestError('Please provide recipientGroup and body');
    }

    const message = await prisma.message.create({
        data: {
            schoolId: req.user.schoolId,
            senderId: userId,
            senderName: name,
            recipientGroup,
            subject: subject || null,
            body,
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Message sent', message });
};

/**
 * Delete a message (sender only)
 */
const deleteMessage = async (req, res) => {
    const { id } = req.params;
    const { userId } = req.user;
    const msg = await prisma.message.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!msg) throw new CustomError.NotFoundError('Message not found');
    if (msg.senderId !== userId) throw new CustomError.UnauthorizedError('Cannot delete another user\'s message');
    // Soft delete the message
    await prisma.message.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: { isDeleted: true, deletedAt: new Date() }
    });
    res.status(StatusCodes.OK).json({ msg: 'Message deleted' });
};


// ─── BULK SMS SERVICE ──────────────────────────────────────────────────────────

/**
 * Get SMS logs
 */
const getSmsLogs = async (req, res) => {
    const logs = await prisma.smsLog.findMany({
        where: { schoolId: req.user.schoolId },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });

    const totalCount = await prisma.smsLog.count({ where: { schoolId: req.user.schoolId } });
    const totalSent = await prisma.smsLog.aggregate({ _sum: { recipientCount: true }, where: { schoolId: req.user.schoolId } });
    const delivered = await prisma.smsLog.count({ where: { status: 'DELIVERED', schoolId: req.user.schoolId } });

    res.status(StatusCodes.OK).json({
        logs,
        stats: {
            totalBatches: totalCount,
            totalRecipients: totalSent._sum.recipientCount || 0,
            deliveryRate: totalCount > 0 ? Math.round((delivered / totalCount) * 100) : 100,
        }
    });
};

/**
 * Send bulk SMS — resolve recipient count from DB, log the SMS
 */
const sendSms = async (req, res) => {
    const { category, message, recipientGroups } = req.body;
    const { name } = req.user;

    if (!message?.trim() || !recipientGroups?.length) {
        throw new CustomError.BadRequestError('Please provide message and recipientGroups');
    }

    const smsQueue = getSmsQueue();

    if (smsQueue) {
        // Enqueue the job for asynchronous processing by the worker.
        await smsQueue.add('dispatch-batch-sms', {
            schoolId: req.user.schoolId,
            category,
            message,
            recipientGroups,
            sentBy: name
        });

        res.status(StatusCodes.ACCEPTED).json({
            msg: `SMS batch has been queued for delivery to ${recipientGroups.join(', ')}`,
        });
    } else {
        // Fallback or local dev mock (if Redis is disabled) 
        // Just store the log immediately
        const logEntry = await prisma.smsLog.create({
            data: {
                schoolId: req.user.schoolId,
                category: category || 'Custom',
                message,
                recipientGroup: recipientGroups.join(', '),
                recipientCount: 0, // Mocked local
                sentBy: name,
                status: 'DELIVERED',
            }
        });

        res.status(StatusCodes.CREATED).json({
            msg: `Local mock output. SMS batch sent to ${recipientGroups.join(', ')}`,
            log: logEntry
        });
    }
};

/**
 * Get recipient group counts from live DB data — used to populate the SMS composer
 */
const getRecipientGroups = async (req, res) => {
    const [parents, students, allStudents, teachers] = await Promise.all([
        prisma.parentProfile.count({ where: { schoolId: req.user.schoolId } }),
        prisma.studentProfile.count({ where: { status: 'Active', schoolId: req.user.schoolId } }),
        prisma.studentProfile.groupBy({ by: ['classLevel'], _count: { id: true }, where: { schoolId: req.user.schoolId } }),
        prisma.teacherProfile.count({ where: { status: 'Active', schoolId: req.user.schoolId } }),
    ]);

    const groups = [
        { id: 'all', label: 'Everyone (All)', count: parents + students + teachers, type: 'all' },
        { id: 'all-parents', label: 'All Parents / Guardians', count: parents, type: 'role' },
        { id: 'all-students', label: 'All Students', count: students, type: 'role' },
        { id: 'all-teachers', label: 'All Teaching Staff', count: teachers, type: 'role' },
        ...allStudents.map(g => ({
            id: g.classLevel.toLowerCase().replace(/\s+/g, ''),
            label: `${g.classLevel} (Students)`,
            count: g._count.id,
            type: 'class',
        })),
    ];

    res.status(StatusCodes.OK).json({ groups });
};


module.exports = {
    getMessages,
    getThreads,
    getThread,
    sendMessage,
    deleteMessage,
    getSmsLogs,
    sendSms,
    getRecipientGroups,
};
