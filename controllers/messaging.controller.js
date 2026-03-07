const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── INTERNAL MESSAGING ────────────────────────────────────────────────────────

/**
 * Get all messages where sender is current user OR message is addressed to them
 */
const getMessages = async (req, res) => {
    const { userId, name } = req.user;
    const { group } = req.query; // filter by recipientGroup

    const where = group
        ? { recipientGroup: group }
        : {
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
            senderId: senderId || userId,
            recipientGroup: recipientGroup,
        },
        orderBy: { createdAt: 'asc' },
    });

    // Mark as read
    await prisma.message.updateMany({
        where: {
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
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg) throw new CustomError.NotFoundError('Message not found');
    if (msg.senderId !== userId) throw new CustomError.UnauthorizedError('Cannot delete another user\'s message');
    await prisma.message.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Message deleted' });
};


// ─── BULK SMS SERVICE ──────────────────────────────────────────────────────────

/**
 * Get SMS logs
 */
const getSmsLogs = async (req, res) => {
    const logs = await prisma.smsLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
    });

    const totalCount = await prisma.smsLog.count();
    const totalSent = await prisma.smsLog.aggregate({ _sum: { recipientCount: true } });
    const delivered = await prisma.smsLog.count({ where: { status: 'DELIVERED' } });

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

    // Resolve recipient counts from real data
    let totalCount = 0;
    const resolvedGroups = [];

    for (const groupId of recipientGroups) {
        let count = 0;
        if (groupId === 'all-parents') {
            count = await prisma.parentProfile.count();
        } else if (groupId === 'all-students') {
            count = await prisma.studentProfile.count({ where: { status: 'Active' } });
        } else if (groupId === 'all-teachers') {
            count = await prisma.teacherProfile.count({ where: { status: 'Active' } });
        } else if (groupId === 'all') {
            const p = await prisma.parentProfile.count();
            const s = await prisma.studentProfile.count({ where: { status: 'Active' } });
            const t = await prisma.teacherProfile.count({ where: { status: 'Active' } });
            count = p + s + t;
        } else {
            // class-level: count students in that class
            const classLevel = groupId.toUpperCase().replace('-', ' '); // jss1 -> JSS 1
            count = await prisma.studentProfile.count({ where: { classLevel: { contains: classLevel, mode: 'insensitive' } } });
        }
        totalCount += count;
        resolvedGroups.push(groupId);
    }

    // In production: integrate actual SMS gateway (Termii, Twilio, etc.)
    // For now we mock the send and log it
    const logEntry = await prisma.smsLog.create({
        data: {
            category: category || 'Custom',
            message,
            recipientGroup: resolvedGroups.join(', '),
            recipientCount: totalCount,
            sentBy: name,
            status: 'DELIVERED',
        }
    });

    res.status(StatusCodes.CREATED).json({
        msg: `SMS batch sent to ${totalCount} recipients`,
        log: logEntry
    });
};

/**
 * Get recipient group counts from live DB data — used to populate the SMS composer
 */
const getRecipientGroups = async (req, res) => {
    const [parents, students, allStudents, teachers] = await Promise.all([
        prisma.parentProfile.count(),
        prisma.studentProfile.count({ where: { status: 'Active' } }),
        prisma.studentProfile.groupBy({ by: ['classLevel'], _count: { id: true } }),
        prisma.teacherProfile.count({ where: { status: 'Active' } }),
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
