
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { logTenantAction } = require('../services/audit-log.service')

// ─── CREATE CLASS ─────────────────────────────────────────────────────────────
const addClass = async (req, res) => {
    const { name, level, section, capacity } = req.body
    if (!name || !level) throw new CustomError.BadRequestError('Class name and level are required')

    const existing = await prisma.class.findFirst({ where: { name, schoolId: req.user.schoolId } })
    if (existing) throw new CustomError.BadRequestError(`A class named "${name}" already exists for this school`)

    const newClass = await prisma.class.create({
        data: {
            name: name.trim().toUpperCase(),
            level: level.trim().toUpperCase(),
            section: section?.trim() || null,
            capacity: capacity ? parseInt(capacity) : 40,
            status: 'Active',
            schoolId: req.user.schoolId
        }
    })
    res.status(StatusCodes.CREATED).json({ msg: 'Class created successfully', class: newClass })
}

// ─── GET ALL CLASSES ──────────────────────────────────────────────────────────
const getAllClasses = async (req, res) => {
    const schoolId = req.user.schoolId
    if (!schoolId) {
        return res.status(StatusCodes.FORBIDDEN).json({ msg: 'No school context found for this user.' })
    }

    const classes = await prisma.class.findMany({
        where: {
            schoolId,
            isDeleted: false,
            NOT: { schoolId: null }  // safety guard: never return null-schoolId orphans
        },
        include: {
            subjects: {
                include: {
                    subject: true,
                    teacher: { include: { user: { select: { name: true } } } }
                }
            },
            formTeacher: { include: { user: { select: { name: true } } } }
        },
        orderBy: { name: 'asc' }
    })
    res.status(StatusCodes.OK).json({ classes, count: classes.length })
}

// ─── GET SINGLE CLASS ─────────────────────────────────────────────────────────
const getClass = async (req, res) => {
    const { id } = req.params
    const cls = await prisma.class.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false },
        include: {
            subjects: {
                include: {
                    subject: true,
                    teacher: { include: { user: { select: { name: true } } } }
                }
            },
            formTeacher: { include: { user: { select: { name: true } } } }
        }
    })
    if (!cls) throw new CustomError.NotFoundError(`No class found with id: ${id}`)
    res.status(StatusCodes.OK).json({ class: cls })
}

// ─── UPDATE CLASS ─────────────────────────────────────────────────────────────
const updateClass = async (req, res) => {
    const { id } = req.params
    const { name, level, section, capacity, status } = req.body
    await prisma.class.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: {
            ...(name && { name: name.trim().toUpperCase() }),
            ...(level && { level: level.trim().toUpperCase() }),
            ...(section !== undefined && { section }),
            ...(capacity && { capacity: parseInt(capacity) }),
            ...(status && { status })
        }
    })
    res.status(StatusCodes.OK).json({ msg: 'Class updated successfully' })
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

    // Ensure the ClassSubject relationship exists, then update it
    const updated = await prisma.classSubject.update({
        where: {
            classId_subjectId: {
                classId: id,
                subjectId: subjectId
            }
        },
        data: {
            teacherId: teacherId || null
        }
    })

    res.status(StatusCodes.OK).json({ msg: 'Subject teacher assigned successfully', assignment: updated })
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
