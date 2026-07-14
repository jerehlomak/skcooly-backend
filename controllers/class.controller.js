
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { logTenantAction } = require('../services/audit-log.service')

// ─── CREATE CLASS ─────────────────────────────────────────────────────────────
const addClass = async (req, res) => {
    const { name, sectionId, arms, sessionId, order } = req.body
    if (!name || !sectionId) throw new CustomError.BadRequestError('Class base name and section are required')

    const school = await prisma.school.findUnique({
        where: { id: req.user.schoolId },
        include: { plan: true }
    });

    if (school && school.plan && school.plan.maxClasses) {
        const currentClassCount = await prisma.class.count({
            where: { schoolId: req.user.schoolId, isDeleted: false }
        });
        const classesToAdd = (arms && Array.isArray(arms) && arms.length > 0) ? arms.length : 1;
        if (currentClassCount + classesToAdd > school.plan.maxClasses) {
            throw new CustomError.ForbiddenError(`Plan limit reached: Maximum allowed classes is ${school.plan.maxClasses}. Please upgrade your plan to add more.`);
        }
    }

    const section = await prisma.section.findUnique({ where: { id: sectionId } })
    if (!section) throw new CustomError.BadRequestError('Invalid section selected')

    // Store the base name as the "level" for backward compatibility
    const baseLevel = name.trim().toUpperCase()

    if (arms && Array.isArray(arms) && arms.length > 0) {
        const classesToCreate = arms.map((arm, index) => ({
            name: `${name} ${arm}`.trim().toUpperCase(),
            level: baseLevel,
            sectionId: sectionId,
            order: order !== undefined ? order + index : 0,
            sessionId: sessionId || null,
            status: 'Active',
            schoolId: req.user.schoolId
        }))
        const newClasses = await prisma.$transaction(classesToCreate.map(data => prisma.class.create({ data })))
        return res.status(StatusCodes.CREATED).json({ msg: 'Classes created successfully', classes: newClasses })
    }

    const className = name.trim().toUpperCase()
    const existing = await prisma.class.findFirst({ where: { name: className, schoolId: req.user.schoolId } })
    if (existing) throw new CustomError.BadRequestError(`A class named "${className}" already exists for this school`)

    const newClass = await prisma.class.create({
        data: {
            name: className,
            level: baseLevel,
            sectionId: sectionId,
            order: order !== undefined ? order : 0,
            sessionId: sessionId || null,
            status: 'Active',
            schoolId: req.user.schoolId
        }
    })
    res.status(StatusCodes.CREATED).json({ msg: 'Class created successfully', class: newClass })
}

// ─── GET ALL CLASSES ──────────────────────────────────────────────────────────
const getAllClasses = async (req, res) => {
    let schoolId = req.user?.schoolId;
    if (!schoolId) {
        schoolId = (await prisma.school.findFirst()).id;
    }

    const { search, page, limit, sectionId } = req.query;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 200;
    const skip = (pageNum - 1) * limitNum;

    const where = {
        schoolId,
        isDeleted: false,
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
        ...(sectionId ? { sectionId } : {})
    };

    const [classes, total] = await Promise.all([
        prisma.class.findMany({
            where,
            skip,
            take: limitNum,
            orderBy: [{ sectionId: 'asc' }, { order: 'asc' }, { name: 'asc' }],
            include: {
                formTeacher: { select: { id: true, user: { select: { name: true } } } },
                sectionRel: { select: { id: true, name: true, shortCode: true, type: true } },
                session: { select: { id: true, name: true } },
                students: { where: { isDeleted: false }, select: { id: true } },
                subjects: {
                    select: {
                        id: true,
                        subjectId: true,
                        teacherId: true,
                        subject: { select: { name: true } }
                    }
                }
            }
        }),
        prisma.class.count({ where })
    ]);

    res.status(StatusCodes.OK).json({ classes, total, page: pageNum, pages: Math.ceil(total / limitNum) });
}

// ─── GET SINGLE CLASS ─────────────────────────────────────────────────────────
const getClass = async (req, res) => {
    const { id } = req.params
    const cls = await prisma.class.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false },
        include: {
            formTeacher: { include: { user: { select: { id: true, name: true, email: true } } } },
            sectionRel: true,
            session: true,
            subjects: { include: { subject: true, teacher: { include: { user: { select: { name: true } } } } } },
            students: { where: { isDeleted: false }, include: { user: { select: { name: true } } } }
        }
    })
    if (!cls) throw new CustomError.NotFoundError('Class not found')
    res.status(StatusCodes.OK).json({ class: cls })
}

// ─── UPDATE CLASS ─────────────────────────────────────────────────────────────
const updateClass = async (req, res) => {
    const { id } = req.params
    const { name, level, sectionId, sessionId, status, section, nextTermFee } = req.body

    const updateData = {}
    if (name !== undefined) updateData.name = name.trim().toUpperCase()
    if (level !== undefined) updateData.level = level.trim().toUpperCase()
    if (sectionId !== undefined) updateData.sectionId = sectionId || null
    if (sessionId !== undefined) updateData.sessionId = sessionId || null
    if (status !== undefined) updateData.status = status
    if (section !== undefined) updateData.section = section || null
    if (nextTermFee !== undefined) updateData.nextTermFee = nextTermFee || null

    // If sectionId provided, update the level from the section name for consistency
    if (sectionId) {
        const sec = await prisma.section.findUnique({ where: { id: sectionId } })
        if (!sec) throw new CustomError.BadRequestError('Invalid section selected')
    }

    await prisma.class.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: updateData
    })

    const updated = await prisma.class.findFirst({
        where: { id },
        include: { sectionRel: true, session: true }
    })

    res.status(StatusCodes.OK).json({ msg: 'Class updated successfully', class: updated })
}

// ─── ASSIGN FORM TEACHER ──────────────────────────────────────────────────────
const assignFormTeacher = async (req, res) => {
    const { id } = req.params
    const { teacherId } = req.body

    // If teacherId is null or empty, it unassigns the form teacher
    await prisma.class.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: { formTeacherId: teacherId || null }
    })
    res.status(StatusCodes.OK).json({ msg: 'Form teacher updated successfully' })
}

// ─── ASSIGN SUBJECT TEACHER ───────────────────────────────────────────────────
const assignSubjectTeacher = async (req, res) => {
    const { id, subjectId } = req.params
    const { teacherId } = req.body

    try {
        const updated = await prisma.classSubject.upsert({
            where: {
                classId_subjectId: {
                    classId: id,
                    subjectId: subjectId
                }
            },
            update: {
                teacherId: teacherId || null
            },
            create: {
                classId: id,
                subjectId: subjectId,
                teacherId: teacherId || null
            }
        })

        res.status(StatusCodes.OK).json({ msg: 'Subject teacher assigned successfully', assignment: updated })
    } catch (error) {
        require('fs').writeFileSync('C:/Users/Jereh Lomak/Desktop/my-projects/skooly/backend/assign_error.log', error.stack || error.toString());
        throw error;
    }
}

// ─── DELETE CLASS ─────────────────────────────────────────────────────────────
const deleteClass = async (req, res) => {
    const { id } = req.params

    // Soft Delete the class
    await prisma.class.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: { isDeleted: true, deletedAt: new Date(), status: 'Deleted' }
    })

    // Log the deletion action
    await logTenantAction({
        schoolId: req.user.schoolId,
        userId: req.user.userId,
        action: 'DELETE_CLASS',
        entityType: 'Class',
        entityId: id,
        ipAddress: req.ip
    })

    res.status(StatusCodes.OK).json({ msg: 'Class deleted successfully' })
}

module.exports = { addClass, getAllClasses, getClass, updateClass, deleteClass, assignFormTeacher, assignSubjectTeacher }
