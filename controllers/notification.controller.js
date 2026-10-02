const { StatusCodes } = require('http-status-codes');
const prisma = require('../db/prisma');
const CustomError = require('../errors');

const ADMIN_ROLES = ['SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN', 'ADMIN'];

// Admins see school-level notifications (as before) plus anything addressed to them personally;
// every other role sees the notifications addressed to them (e.g. timetable alerts).
const getMyNotifications = async (req, res) => {
    const { schoolId, userId, role } = req.user;
    const isAdmin = ADMIN_ROLES.includes(role);

    const [mine, mineUnread, school, schoolUnread] = await Promise.all([
        prisma.userNotification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
        prisma.userNotification.count({ where: { userId, isRead: false } }),
        isAdmin ? prisma.notification.findMany({ where: { schoolId }, orderBy: { createdAt: 'desc' }, take: 20 }) : [],
        isAdmin ? prisma.notification.count({ where: { schoolId, isRead: false } }) : 0,
    ]);

    const notifications = [...mine, ...school].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
    res.status(StatusCodes.OK).json({ notifications, unreadCount: mineUnread + schoolUnread });
};

const markAsRead = async (req, res) => {
    const { id } = req.params;
    const { schoolId, userId } = req.user;

    const own = await prisma.userNotification.updateMany({ where: { id, userId }, data: { isRead: true } });
    if (own.count) return res.status(StatusCodes.OK).json({ msg: 'Marked as read' });

    const notif = await prisma.notification.findUnique({ where: { id } });
    if (!notif || notif.schoolId !== schoolId || !ADMIN_ROLES.includes(req.user.role)) {
        throw new CustomError.NotFoundError('Notification not found');
    }
    await prisma.notification.update({ where: { id }, data: { isRead: true } });
    res.status(StatusCodes.OK).json({ msg: 'Marked as read' });
};

const markAllAsRead = async (req, res) => {
    const { schoolId, userId, role } = req.user;
    await prisma.userNotification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
    if (ADMIN_ROLES.includes(role)) {
        await prisma.notification.updateMany({ where: { schoolId, isRead: false }, data: { isRead: true } });
    }
    res.status(StatusCodes.OK).json({ msg: 'All marked as read' });
};

module.exports = {
    getMyNotifications,
    markAsRead,
    markAllAsRead
};
