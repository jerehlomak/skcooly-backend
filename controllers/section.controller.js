const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { logTenantAction } = require('../services/audit-log.service');

const createSection = async (req, res) => {
    const { name, arabicName, type } = req.body;
    const schoolId = req.user.schoolId;

    if (!name) {
        throw new CustomError.BadRequestError('Section name is required');
    }

    const section = await prisma.section.create({
        data: {
            schoolId,
            name,
            arabicName: arabicName || null,
            type: type || null
        }
    });

    await logTenantAction({
        schoolId,
        userId: req.user.userId,
        action: 'CREATE_SECTION',
        entityType: 'Section',
        entityId: section.id,
        ipAddress: req.ip
    });

    res.status(StatusCodes.CREATED).json({ section });
};

const getAllSections = async (req, res) => {
    const schoolId = req.user.schoolId;
    const sections = await prisma.section.findMany({
        where: { schoolId, isDeleted: false },
        orderBy: { createdAt: 'asc' }
    });
    res.status(StatusCodes.OK).json({ sections });
};

const updateSection = async (req, res) => {
    const { id } = req.params;
    const { name, arabicName, type } = req.body;
    const schoolId = req.user.schoolId;

    const existingSection = await prisma.section.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!existingSection) {
        throw new CustomError.NotFoundError(`No section with id: ${id}`);
    }

    const section = await prisma.section.update({
        where: { id },
        data: {
            ...(name && { name }),
            ...(arabicName !== undefined && { arabicName }),
            ...(type !== undefined && { type })
        }
    });

    res.status(StatusCodes.OK).json({ section });
};

const deleteSection = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    const section = await prisma.section.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!section) {
        throw new CustomError.NotFoundError(`No section with id: ${id}`);
    }

    await prisma.section.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() }
    });

    await logTenantAction({
        schoolId,
        userId: req.user.userId,
        action: 'DELETE_SECTION',
        entityType: 'Section',
        entityId: id,
        ipAddress: req.ip
    });

    res.status(StatusCodes.OK).json({ msg: 'Section deleted successfully' });
};

module.exports = {
    createSection,
    getAllSections,
    updateSection,
    deleteSection
};
