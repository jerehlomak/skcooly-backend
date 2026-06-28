const { StatusCodes } = require('http-status-codes');
const prisma = require('../db/prisma');
const CustomError = require('../errors');

const getMyNotifications = async (req, res) => {
    const schoolId = req.user.schoolId;
    // only admins can see school-level notifications for now
    if (!['SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN', 'ADMIN'].includes(req.user.role)) {
        return res.status(StatusCodes.OK).json({ notifications: [], unreadCount: 0 });
    }

    const notifications = await prisma.notification.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: 20
    });

    const unreadCount = await prisma.notification.count({
        where: { schoolId, isRead: false }
    });

    res.status(StatusCodes.OK).json({ notifications, unreadCount });
};

const markAsRead = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    const notif = await prisma.notification.findUnique({ where: { id } });
    if (!notif || notif.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Notification not found');
    }

    await prisma.notification.update({
        where: { id },
        data: { isRead: true }
    });

    res.status(StatusCodes.OK).json({ msg: 'Marked as read' });
};

const markAllAsRead = async (req, res) => {
    const schoolId = req.user.schoolId;
    
    await prisma.notification.updateMany({
        where: { schoolId, isRead: false },
        data: { isRead: true }
    });

    res.status(StatusCodes.OK).json({ msg: 'All marked as read' });
};

module.exports = {
    getMyNotifications,
    markAsRead,
    markAllAsRead
};
