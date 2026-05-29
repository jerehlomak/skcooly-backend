const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { logTenantAction } = require('../services/audit-log.service');

const createCategory = async (req, res) => {
    const { name } = req.body;
    const schoolId = req.user.schoolId;

    if (!name) {
        throw new CustomError.BadRequestError('Category name is required');
    }

    const category = await prisma.subjectCategory.create({
        data: {
            schoolId,
            name
        }
    });

    await logTenantAction({
        schoolId,
        userId: req.user.userId,
        action: 'CREATE_SUBJECT_CATEGORY',
        entityType: 'SubjectCategory',
        entityId: category.id,
        ipAddress: req.ip
    });

    res.status(StatusCodes.CREATED).json({ category });
};

const getAllCategories = async (req, res) => {
    const schoolId = req.user.schoolId;
    const categories = await prisma.subjectCategory.findMany({
        where: { schoolId, isDeleted: false },
        orderBy: { createdAt: 'asc' }
    });
    res.status(StatusCodes.OK).json({ categories });
};

const updateCategory = async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    const schoolId = req.user.schoolId;

    const existing = await prisma.subjectCategory.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!existing) {
        throw new CustomError.NotFoundError(`No category with id: ${id}`);
    }

    const category = await prisma.subjectCategory.update({
        where: { id },
        data: {
            ...(name && { name })
        }
    });

    res.status(StatusCodes.OK).json({ category });
};

const deleteCategory = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    const category = await prisma.subjectCategory.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!category) {
        throw new CustomError.NotFoundError(`No category with id: ${id}`);
    }

    await prisma.subjectCategory.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() }
    });

    await logTenantAction({
        schoolId,
        userId: req.user.userId,
        action: 'DELETE_SUBJECT_CATEGORY',
        entityType: 'SubjectCategory',
        entityId: id,
        ipAddress: req.ip
    });

    res.status(StatusCodes.OK).json({ msg: 'Subject Category deleted successfully' });
};

module.exports = {
    createCategory,
    getAllCategories,
    updateCategory,
    deleteCategory
};
