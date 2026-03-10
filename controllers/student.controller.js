
const prisma = require('../db/prisma');
const argon2 = require('argon2')
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')

// Helper function to generate a random readable 8 character password
const generateRandomPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // No confusing 0/O and 1/I/l
    let password = ''
    for (let i = 0; i < 8; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return password
}

// ─── ADD STUDENT ───────────────────────────────────────────────────────────────
const addStudent = async (req, res) => {
    let {
        name, classLevel, classId, gender, phone,
        dateOfBirth, orphan, religion, bloodGroup,
        address, previousSchool, parentProfileId
    } = req.body

    if (!name || (!classLevel && !classId) || !gender) {
        throw new CustomError.BadRequestError('Please provide name, classLevel/classId, and gender')
    }

    // If classId is provided, we fetch the Class to inherit its level
    if (classId) {
        const cls = await prisma.class.findUnique({ where: { id: classId } })
        if (!cls) throw new CustomError.BadRequestError(`Class with ID ${classId} not found`)
        classLevel = cls.level
    }

    const currentYear = new Date().getFullYear()

    // Fetch the school's code to namespace the generated email globally
    const school = await prisma.school.findUnique({
        where: { id: req.user.schoolId },
        select: { schoolCode: true }
    })
    // Sanitize schoolCode for use in email: e.g. "SKL-A1B2C3" → "skla1b2c3"
    const schoolTag = (school?.schoolCode || req.user.schoolId.slice(0, 8))
        .toLowerCase().replace(/[^a-z0-9]/g, '')

    // Generate unique admission number (scoped to this school)
    const lastStudent = await prisma.studentProfile.findFirst({
        where: { admissionNo: { startsWith: `SKL-${currentYear}-` }, schoolId: req.user.schoolId },
        orderBy: { enrollmentDate: 'desc' }
    })

    let sequence = 1
    if (lastStudent) {
        const lastSequenceStr = lastStudent.admissionNo.split('-')[2]
        sequence = parseInt(lastSequenceStr) + 1
    }

    const formattedSequence = sequence.toString().padStart(4, '0')
    const admissionNo = `SKL-${currentYear}-${formattedSequence}`

    // Auto-generate credentials — email is globally unique thanks to schoolTag
    const safeName = name.toLowerCase().replace(/\s+/g, '.')
    const generatedEmail = `${safeName}.${formattedSequence}.${schoolTag}@skooly.student`
    const generatedPassword = generateRandomPassword()
    const hashedPassword = await argon2.hash(generatedPassword)

    const newStudent = await prisma.$transaction(async (tx) => {
        return await tx.user.create({
            data: {
                name,
                email: generatedEmail,
                password: hashedPassword,
                role: 'STUDENT',
                schoolId: req.user.schoolId,
                studentProfile: {
                    create: {
                        schoolId: req.user.schoolId,
                        admissionNo,
                        classLevel,
                        classId: classId || null,
                        gender,
                        phone: phone || null,
                        status: 'Active',
                        // Optional extended fields
                        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
                        orphan: orphan === true || orphan === 'yes',
                        religion: religion || null,
                        bloodGroup: bloodGroup || null,
                        address: address || null,
                        previousSchool: previousSchool || null,
                        parentProfileId: parentProfileId || null
                    }
                }
            },
            select: {
                id: true, name: true, email: true, role: true,
                studentProfile: { include: { classArm: true } }
            }
        })
    })

    res.status(StatusCodes.CREATED).json({
        msg: 'Student created successfully',
        student: newStudent,
        credentials: { admissionNo, loginEmail: generatedEmail, generatedPassword }
    })
}

// ─── GET ALL STUDENTS ──────────────────────────────────────────────────────────
const getAllStudents = async (req, res) => {
    const schoolId = req.user.schoolId
    if (!schoolId) {
        return res.status(StatusCodes.FORBIDDEN).json({ msg: 'No school context found for this user.' })
    }

    const students = await prisma.studentProfile.findMany({
        where: {
            schoolId,          // only this school
            NOT: { schoolId: null }  // safety guard: never return null-schoolId orphans
        },
        include: {
            user: { select: { id: true, name: true, email: true, role: true } },
            classArm: { select: { name: true, level: true } },
            parent: {
                include: { user: { select: { name: true } } }
            }
        },
        orderBy: { enrollmentDate: 'desc' }
    })
    res.status(StatusCodes.OK).json({ students, count: students.length })
}

// ─── GET SINGLE STUDENT ────────────────────────────────────────────────────────
const getStudent = async (req, res) => {
    const { id } = req.params // This is the User.id

    const user = await prisma.user.findFirst({
        where: { id, schoolId: req.user.schoolId },
        include: {
            studentProfile: {
                include: {
                    parent: {
                        include: { user: { select: { name: true, email: true } } }
                    }
                }
            }
        }
    })

    if (!user || !user.studentProfile) {
        throw new CustomError.NotFoundError(`No student found with id: ${id}`)
    }

    res.status(StatusCodes.OK).json({ student: user.studentProfile, user })
}

// ─── UPDATE STUDENT ────────────────────────────────────────────────────────────
const updateStudent = async (req, res) => {
    const { id } = req.params // This is the User.id
    let {
        name, classLevel, classId, gender, phone, status,
        dateOfBirth, orphan, religion, bloodGroup,
        address, previousSchool, parentProfileId
    } = req.body

    // Update User name if provided
    const updateData = {}
    if (name) updateData.name = name

    // If classId is provided, we fetch the Class to inherit its level
    if (classId) {
        const cls = await prisma.class.findUnique({ where: { id: classId } })
        if (!cls) throw new CustomError.BadRequestError(`Class with ID ${classId} not found`)
        classLevel = cls.level
    }

    await prisma.user.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: {
            ...updateData,
        }
    })

    // Because updateMany doesn't support nested updates, we update the profile separately
    if (Object.keys(updateData).length > 0 || classLevel || classId || gender || status || phone || dateOfBirth || orphan !== undefined || religion || bloodGroup || address || previousSchool || parentProfileId) {
        await prisma.studentProfile.update({
            where: { userId: id },
            data: {
                ...(classLevel && { classLevel }),
                ...(classId && { classId }),
                ...(gender && { gender }),
                ...(status && { status }),
                phone: phone !== undefined ? phone : undefined,
                dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
                orphan: orphan !== undefined ? (orphan === true || orphan === 'yes') : undefined,
                religion: religion !== undefined ? religion : undefined,
                bloodGroup: bloodGroup !== undefined ? bloodGroup : undefined,
                address: address !== undefined ? address : undefined,
                previousSchool: previousSchool !== undefined ? previousSchool : undefined,
                parentProfileId: parentProfileId !== undefined ? parentProfileId : undefined
            }
        })
    }

    res.status(StatusCodes.OK).json({ msg: 'Student updated successfully' })
}

// ─── DELETE STUDENT ────────────────────────────────────────────────────────────
const deleteStudent = async (req, res) => {
    const { id } = req.params
    // Cascade via Prisma schema — deleting User deletes StudentProfile too
    await prisma.user.deleteMany({ where: { id, schoolId: req.user.schoolId } })
    res.status(StatusCodes.OK).json({ msg: 'Student deleted successfully' })
}


module.exports = { addStudent, getAllStudents, getStudent, updateStudent, deleteStudent }
