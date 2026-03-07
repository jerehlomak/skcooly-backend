
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')

// ─── CREATE CLASS ─────────────────────────────────────────────────────────────
const addClass = async (req, res) => {
    const { name, level, section, capacity } = req.body
    if (!name || !level) throw new CustomError.BadRequestError('Class name and level are required')

    const existing = await prisma.class.findUnique({ where: { name } })
    if (existing) throw new CustomError.BadRequestError(`A class named "${name}" already exists`)

    const newClass = await prisma.class.create({
        data: {
            name: name.trim().toUpperCase(),
            level: level.trim().toUpperCase(),
            section: section?.trim() || null,
            capacity: capacity ? parseInt(capacity) : 40,
            status: 'Active'
        }
    })
    res.status(StatusCodes.CREATED).json({ msg: 'Class created successfully', class: newClass })
}

// ─── GET ALL CLASSES ──────────────────────────────────────────────────────────
const getAllClasses = async (req, res) => {
    const classes = await prisma.class.findMany({
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
    const cls = await prisma.class.findUnique({
        where: { id },
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
    await prisma.class.update({
        where: { id },
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
    await prisma.class.update({
        where: { id },
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
    await prisma.class.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ msg: 'Class deleted successfully' })
}

module.exports = { addClass, getAllClasses, getClass, updateClass, deleteClass, assignFormTeacher, assignSubjectTeacher }
