const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { logTenantAction } = require('../services/audit-log.service');

// ─── CREATE SECTION ───────────────────────────────────────────────────────────
const createSection = async (req, res) => {
    const { name, shortCode } = req.body;
    if (!name) throw new CustomError.BadRequestError('Section name is required');

    const existing = await prisma.section.findFirst({
        where: { name, schoolId: req.user.schoolId, isDeleted: false }
    });
    if (existing) throw new CustomError.BadRequestError(`A section named "${name}" already exists`);

    const section = await prisma.section.create({
        data: {
            name: name.trim(),
            shortCode: shortCode ? shortCode.trim() : null,
            schoolId: req.user.schoolId
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Section created successfully', section });
};

// ─── GET ALL SECTIONS ─────────────────────────────────────────────────────────
const getSections = async (req, res) => {
    let schoolId = req.user?.schoolId;
    if (!schoolId) {
        schoolId = (await prisma.school.findFirst()).id;
    }

    const sections = await prisma.section.findMany({
        where: { schoolId, isDeleted: false },
        include: {
            _count: {
                select: { classes: { where: { isDeleted: false } } }
            }
        },
        orderBy: { createdAt: 'asc' }
    });

    res.status(StatusCodes.OK).json({ sections, count: sections.length });
};

// ─── UPDATE SECTION ───────────────────────────────────────────────────────────
const updateSection = async (req, res) => {
    const { id } = req.params;
    const { name, shortCode } = req.body;

    const existing = await prisma.section.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false }
    });
    if (!existing) throw new CustomError.NotFoundError(`No section found with id: ${id}`);

    if (name && name !== existing.name) {
        const nameCheck = await prisma.section.findFirst({
            where: { name, schoolId: req.user.schoolId, isDeleted: false }
        });
        if (nameCheck) throw new CustomError.BadRequestError(`A section named "${name}" already exists`);
    }

    const section = await prisma.section.update({
        where: { id },
        data: {
            ...(name && { name: name.trim() }),
            ...(shortCode !== undefined && { shortCode: shortCode?.trim() || null })
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Section updated successfully', section });
};

// ─── DELETE SECTION ───────────────────────────────────────────────────────────
const deleteSection = async (req, res) => {
    const { id } = req.params;
    const { force } = req.query;

    const existing = await prisma.section.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false },
        include: {
            _count: { select: { classes: { where: { isDeleted: false } } } }
        }
    });

    if (!existing) throw new CustomError.NotFoundError(`No section found with id: ${id}`);

    // If there are classes linked to this section, warn the user unless they passed ?force=true
    if (existing._count.classes > 0 && force !== 'true') {
        throw new CustomError.BadRequestError(`Cannot delete section. There are ${existing._count.classes} classes linked to this section. Please reassign or delete those classes first, or confirm force deletion.`);
    }

    // Soft delete
    await prisma.section.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() }
    });

    // Log the action
    await logTenantAction({
        schoolId: req.user.schoolId,
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
    getSections,
    updateSection,
    deleteSection
};
