const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { logTenantAction } = require('../services/audit-log.service');

const createSession = async (req, res) => {
    const { name, startDate, endDate, isCurrent } = req.body;
    const schoolId = req.user.schoolId;

    if (!name) {
        throw new CustomError.BadRequestError('Session name is required');
    }

    if (isCurrent) {
        // Unmark any existing current session for this school
        await prisma.academicSession.updateMany({
            where: { schoolId, isCurrent: true },
            data: { isCurrent: false }
        });
    }

    const session = await prisma.academicSession.create({
        data: {
            schoolId,
            name,
            startDate: startDate ? new Date(startDate) : null,
            endDate: endDate ? new Date(endDate) : null,
            isCurrent: isCurrent || false
        }
    });

    await logTenantAction({
        schoolId,
        userId: req.user.userId,
        action: 'CREATE_SESSION',
        entityType: 'AcademicSession',
        entityId: session.id,
        ipAddress: req.ip
    });

    res.status(StatusCodes.CREATED).json({ session });
};

const getAllSessions = async (req, res) => {
    const schoolId = req.user.schoolId;
    const sessions = await prisma.academicSession.findMany({
        where: { schoolId, isDeleted: false },
        orderBy: { startDate: 'desc' }
    });
    res.status(StatusCodes.OK).json({ sessions });
};

const updateSession = async (req, res) => {
    const { id } = req.params;
    const { name, startDate, endDate, isCurrent } = req.body;
    const schoolId = req.user.schoolId;

    const existingSession = await prisma.academicSession.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!existingSession) {
        throw new CustomError.NotFoundError(`No session with id: ${id}`);
    }

    if (isCurrent) {
        // Unmark existing
        await prisma.academicSession.updateMany({
            where: { schoolId, isCurrent: true, id: { not: id } },
            data: { isCurrent: false }
        });
    }

    const session = await prisma.academicSession.update({
        where: { id },
        data: {
            ...(name && { name }),
            ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
            ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
            ...(isCurrent !== undefined && { isCurrent })
        }
    });

    res.status(StatusCodes.OK).json({ session });
};

const deleteSession = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    const session = await prisma.academicSession.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!session) {
        throw new CustomError.NotFoundError(`No session with id: ${id}`);
    }

    if (session.isCurrent) {
        throw new CustomError.BadRequestError('Cannot delete the current active session');
    }

    await prisma.academicSession.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() }
    });

    await logTenantAction({
        schoolId,
        userId: req.user.userId,
        action: 'DELETE_SESSION',
        entityType: 'AcademicSession',
        entityId: id,
        ipAddress: req.ip
    });

    res.status(StatusCodes.OK).json({ msg: 'Session deleted successfully' });
};


const setCurrentSession = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    await prisma.academicSession.updateMany({
        where: { schoolId },
        data: { isCurrent: false }
    });

    const session = await prisma.academicSession.update({
        where: { id },
        data: { isCurrent: true }
    });

    res.status(StatusCodes.OK).json({ msg: 'Session marked as current successfully', session });
};

module.exports = {
    createSession,
    setCurrentSession,
    getAllSessions,
    updateSession,
    deleteSession
};
