
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { logTenantAction } = require('../services/audit-log.service')

// ─── CREATE SUBJECT ───────────────────────────────────────────────────────────
const addSubject = async (req, res) => {
    const { name, code, categoryId, arabicName, type, stream, description, teacherId, classIds } = req.body
    if (!name) throw new CustomError.BadRequestError('Subject name is required')

    const existing = await prisma.subject.findFirst({ where: { name, schoolId: req.user.schoolId } })
    if (existing) throw new CustomError.BadRequestError(`Subject "${name}" already exists in this school`)

    const newSubject = await prisma.subject.create({
        data: {
            name: name.trim(),
            code: code ? code.trim().toUpperCase() : null,
            categoryId: categoryId || null,
            arabicName: arabicName || null,
            type: type || null,
            stream: stream || 'ALL',
            description: description || null,
            teacherId: teacherId || null,
            schoolId: req.user.schoolId,
            // Link to classes if provided
            classes: classIds && classIds.length > 0
                ? { create: classIds.map(cid => ({ classId: cid })) }
                : undefined
        },
        include: { classes: { include: { class: true } }, teacher: { include: { user: { select: { name: true } } } } }
    })
    res.status(StatusCodes.CREATED).json({ msg: 'Subject created successfully', subject: newSubject })
}

// ─── GET ALL SUBJECTS ─────────────────────────────────────────────────────────
const getAllSubjects = async (req, res) => {
    const { stream, category } = req.query
    const subjects = await prisma.subject.findMany({
        where: {
            schoolId: req.user.schoolId,
            isDeleted: false,
            ...(stream && stream !== 'all' ? { stream } : {}),
            ...(category && category !== 'all' ? { category } : {})
        },
        include: {
            classes: { include: { class: true } },
            category: true,
            teacher: { include: { user: { select: { name: true } } } }
        },
        orderBy: { name: 'asc' }
    })
    res.status(StatusCodes.OK).json({ subjects, count: subjects.length })
}

// ─── GET SINGLE SUBJECT ───────────────────────────────────────────────────────
const getSubject = async (req, res) => {
    const { id } = req.params
    const subject = await prisma.subject.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false },
        include: {
            classes: { include: { class: true } },
            category: true,
            teacher: { include: { user: { select: { name: true, email: true } } } }
        }
    })
    if (!subject) throw new CustomError.NotFoundError(`No subject found with id: ${id}`)
    res.status(StatusCodes.OK).json({ subject })
}

// ─── UPDATE SUBJECT ───────────────────────────────────────────────────────────
const updateSubject = async (req, res) => {
    const { id } = req.params
    const { name, code, categoryId, arabicName, type, stream, description, teacherId, status, classIds } = req.body

    const existing = await prisma.subject.findFirst({ where: { id, schoolId: req.user.schoolId } })
    if (!existing) throw new CustomError.NotFoundError(`No subject found with id: ${id}`)

    const updateData = {
        ...(name && { name: name.trim() }),
        ...(code !== undefined && { code: code ? code.trim().toUpperCase() : null }),
        ...(categoryId && { categoryId }),
        ...(arabicName !== undefined && { arabicName }),
        ...(type !== undefined && { type }),
        ...(stream && { stream }),
        ...(description !== undefined && { description }),
        ...(teacherId !== undefined && { teacherId: teacherId || null }),
        ...(status && { status })
    };

    if (classIds && Array.isArray(classIds)) {
        // If classIds are provided, delete old relations and set new ones
        updateData.classes = {
            deleteMany: {},
            create: classIds.map(cid => ({ classId: cid }))
        };
    }

    await prisma.subject.update({
        where: { id },
        data: updateData
    })
    res.status(StatusCodes.OK).json({ msg: 'Subject updated successfully' })
}

// ─── DELETE SUBJECT ───────────────────────────────────────────────────────────
const deleteSubject = async (req, res) => {
    const { id } = req.params

    // Soft Delete the subject
    await prisma.subject.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: { isDeleted: true, deletedAt: new Date(), status: 'Deleted' }
    })

    // Log the deletion action
    await logTenantAction({
        schoolId: req.user.schoolId,
        userId: req.user.userId,
        action: 'DELETE_SUBJECT',
        entityType: 'Subject',
        entityId: id,
        ipAddress: req.ip
    })

    res.status(StatusCodes.OK).json({ msg: 'Subject deleted successfully' })
}

// ─── GET MY SUBJECTS (Student Portal) ───────────────────────────────────────
// Returns all subjects that are assigned to the authenticated student's class arm
const getMySubjects = async (req, res) => {
    // Resolve the student's class from their profile
    const profile = await prisma.studentProfile.findFirst({
        where: { schoolId: req.user.schoolId, isDeleted: false, user: { id: req.user.userId } },
        select: { id: true, classId: true, classLevel: true }
    });

    if (!profile) throw new CustomError.NotFoundError('Student profile not found');
    if (!profile.classId) {
        return res.status(StatusCodes.OK).json({ subjects: [], count: 0, message: 'No class assigned yet' });
    }

    // Get all subjects linked to this class arm via SubjectClass join table
    const subjects = await prisma.subject.findMany({
        where: {
            schoolId: req.user.schoolId,
            isDeleted: false,
            classes: {
                some: { classId: profile.classId }
            }
        },
        include: {
            teacher: { include: { user: { select: { name: true } } } }
        },
        orderBy: { name: 'asc' }
    });

    res.status(StatusCodes.OK).json({ subjects, count: subjects.length });
};

module.exports = { addSubject, getAllSubjects, getSubject, updateSubject, deleteSubject, getMySubjects }


