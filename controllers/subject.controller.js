
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')

// ─── CREATE SUBJECT ───────────────────────────────────────────────────────────
const addSubject = async (req, res) => {
    const { name, code, category, stream, description, teacherId, classIds } = req.body
    if (!name) throw new CustomError.BadRequestError('Subject name is required')

    const existing = await prisma.subject.findFirst({ where: { name, schoolId: req.user.schoolId } })
    if (existing) throw new CustomError.BadRequestError(`Subject "${name}" already exists in this school`)

    const newSubject = await prisma.subject.create({
        data: {
            name: name.trim(),
            code: code ? code.trim().toUpperCase() : null,
            category: category || 'CORE',
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
            ...(stream && stream !== 'all' ? { stream } : {}),
            ...(category && category !== 'all' ? { category } : {})
        },
        include: {
            classes: { include: { class: true } },
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
        where: { id, schoolId: req.user.schoolId },
        include: {
            classes: { include: { class: true } },
            teacher: { include: { user: { select: { name: true, email: true } } } }
        }
    })
    if (!subject) throw new CustomError.NotFoundError(`No subject found with id: ${id}`)
    res.status(StatusCodes.OK).json({ subject })
}

// ─── UPDATE SUBJECT ───────────────────────────────────────────────────────────
const updateSubject = async (req, res) => {
    const { id } = req.params
    const { name, code, category, stream, description, teacherId, status, classIds } = req.body

    const existing = await prisma.subject.findFirst({ where: { id, schoolId: req.user.schoolId } })
    if (!existing) throw new CustomError.NotFoundError(`No subject found with id: ${id}`)

    const updateData = {
        ...(name && { name: name.trim() }),
        ...(code !== undefined && { code: code ? code.trim().toUpperCase() : null }),
        ...(category && { category }),
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
    await prisma.subject.deleteMany({ where: { id, schoolId: req.user.schoolId } })
    res.status(StatusCodes.OK).json({ msg: 'Subject deleted successfully' })
}

module.exports = { addSubject, getAllSubjects, getSubject, updateSubject, deleteSubject }
