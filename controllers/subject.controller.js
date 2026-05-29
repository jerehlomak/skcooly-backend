
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { logTenantAction } = require('../services/audit-log.service')

// ─── CREATE SUBJECT ───────────────────────────────────────────────────────────
const addSubject = async (req, res) => {
    const { name, code, categoryId, type, description, teacherId, classIds } = req.body
    if (!name) throw new CustomError.BadRequestError('Subject name is required')

    const existing = await prisma.subject.findFirst({ where: { name, schoolId: req.user.schoolId } })
    if (existing) throw new CustomError.BadRequestError(`Subject "${name}" already exists in this school`)
    
    // Auto-generate code if not provided or empty
    let finalCode = code ? code.trim().toUpperCase() : null;
    if (!finalCode) {
        // e.g. SUB-XYZ or based on name
        const prefix = name.substring(0, 3).toUpperCase();
        const randomNum = Math.floor(100 + Math.random() * 900);
        finalCode = `${prefix}-${randomNum}`;
    }

    const newSubject = await prisma.subject.create({
        data: {
            name: name.trim(),
            code: finalCode,
            categoryId: categoryId || null,
            type: type || null,
            description: description || null,
            teacherId: teacherId || null,
            schoolId: req.user.schoolId,
            // Link to classes if provided
            classes: classIds && classIds.length > 0
                ? { create: classIds.map(cid => ({ classId: cid, teacherId: teacherId || null })) }
                : undefined
        },
        include: { classes: { include: { class: true } }, teacher: { include: { user: { select: { name: true } } } } }
    })
    res.status(StatusCodes.CREATED).json({ msg: 'Subject created successfully', subject: newSubject })
}

// ─── GET ALL SUBJECTS ─────────────────────────────────────────────────────────
const getAllSubjects = async (req, res) => {
    const { category, classId, search, page, limit } = req.query
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const skip = (pageNum - 1) * limitNum;

    const where = {
        schoolId: req.user.schoolId,
        isDeleted: false,
        ...(category && category !== 'all' ? { categoryId: category } : {}),
        ...(classId && classId !== 'all' ? { classes: { some: { classId } } } : {}),
        ...(search && {
            OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } }
            ]
        })
    };

    const count = await prisma.subject.count({ where });

    const subjects = await prisma.subject.findMany({
        where,
        include: {
            classes: { include: { class: true } },
            category: true,
            teacher: { include: { user: { select: { name: true } } } }
        },
        orderBy: { name: 'asc' },
        ...(page && limit ? { skip, take: limitNum } : {})
    });
    
    res.status(StatusCodes.OK).json({ 
        subjects, 
        count: page && limit ? count : subjects.length,
        totalPages: page && limit ? Math.ceil(count / limitNum) : 1,
        currentPage: pageNum
    });
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
    const { name, code, categoryId, type, description, teacherId, status, classIds } = req.body

    const existing = await prisma.subject.findFirst({ where: { id, schoolId: req.user.schoolId } })
    if (!existing) throw new CustomError.NotFoundError(`No subject found with id: ${id}`)

    const updateData = {
        ...(name && { name: name.trim() }),
        ...(code !== undefined && { code: code ? code.trim().toUpperCase() : null }),
        ...(categoryId && { categoryId }),
        ...(type !== undefined && { type }),
        ...(description !== undefined && { description }),
        ...(teacherId !== undefined && { teacherId: teacherId || null }),
        ...(status && { status })
    };

    if (classIds && Array.isArray(classIds)) {
        // If classIds are provided, delete old relations and set new ones
        updateData.classes = {
            deleteMany: {},
            create: classIds.map(cid => ({ classId: cid, teacherId: teacherId || null }))
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
    const { force } = req.query

    // Check if subject has existing scores
    if (!force) {
        const scoresExist = await prisma.studentResult.count({
            where: { subjectId: id, schoolId: req.user.schoolId, isDeleted: false }
        });
        // We could also check AssessmentScore if it exists, but usually studentResult is the summary.
        if (scoresExist > 0) {
            throw new CustomError.BadRequestError(`This subject has existing score entries. Deleting it will archive these records but they won't be permanently lost. Pass ?force=true to confirm.`);
        }
    }

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


