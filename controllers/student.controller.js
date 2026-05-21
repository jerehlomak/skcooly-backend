const prisma = require('../db/prisma');
const argon2 = require('argon2')
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { logTenantAction } = require('../services/audit-log.service')
const crypto = require('crypto');
const { publishEvent, EVENTS } = require('../services/event-bus.service')

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
        admissionDate, dateOfBirth, orphan, religion, bloodGroup,
        address, previousSchool, parentProfileId, sessionId, subjectCategoryId
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

    let admissionNo = req.body.admissionNo;
    let sequenceTag = '0001'; // used in email generation

    if (!admissionNo) {
        // Generate unique admission number (scoped to this school)
        const lastStudent = await prisma.studentProfile.findFirst({
            where: { admissionNo: { startsWith: `SKL-${currentYear}-` }, schoolId: req.user.schoolId },
            orderBy: { enrollmentDate: 'desc' }
        })

        let sequence = 1
        if (lastStudent && lastStudent.admissionNo.includes('-')) {
            const parts = lastStudent.admissionNo.split('-');
            if (parts.length >= 3) {
                const lastSequenceStr = parts[2]
                sequence = parseInt(lastSequenceStr) + 1
            }
        }

        const formattedSequence = sequence.toString().padStart(4, '0')
        sequenceTag = formattedSequence
        admissionNo = `SKL-${currentYear}-${formattedSequence}`
    } else {
        // Derive a short sequence tag from the custom admissionNo for email uniqueness
        sequenceTag = admissionNo.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-6);
    }
    
    // Always use a globally unique UUID for publicId to prevent collisions
    const publicId = `STU-${crypto.randomUUID().slice(0, 8).toUpperCase()}-${Date.now().toString().slice(-4)}`;

    // Auto-generate credentials — email is globally unique thanks to schoolTag
    // Sanitize name fully so Arabic/special chars don't break email format
    const safeName = (name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '') || 'student')
    const generatedEmail = `${safeName}.${sequenceTag}.${schoolTag}@skooly.student`
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
                        sessionId: sessionId || null,
                        gender,
                        phone: phone || null,
                        status: 'Active',
                        // Date fields
                        admissionDate: admissionDate ? new Date(admissionDate) : new Date(),
                        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
                        orphan: orphan === true || orphan === 'yes',
                        religion: religion || null,
                        bloodGroup: bloodGroup || null,
                        address: address || null,
                        previousSchool: previousSchool || null,
                        parentProfileId: parentProfileId || null,
                        arabicName: req.body.arabicName || null,
                        subjectCategoryId: subjectCategoryId || null,
                        publicId
                    }
                }
            },
            select: {
                id: true, name: true, email: true, role: true,
                studentProfile: { include: { classArm: true } }
            }
        })
    })

    // Emit domain event for decoupling downstream effects
    publishEvent(EVENTS.STUDENT_CREATED, {
        schoolId: req.user.schoolId,
        studentId: newStudent.id,
        admissionNo, 
        email: generatedEmail
    });

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
            isDeleted: false,  // soft delete check
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
        where: { id, schoolId: req.user.schoolId, isDeleted: false },
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
        admissionDate, dateOfBirth, orphan, religion, bloodGroup,
        address, previousSchool, parentProfileId, sessionId, subjectCategoryId
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
    if (Object.keys(updateData).length > 0 || classLevel || classId || gender || status || phone || dateOfBirth || orphan !== undefined || religion || bloodGroup || address || previousSchool || parentProfileId || req.body.arabicName !== undefined || subjectCategoryId !== undefined) {
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
                parentProfileId: parentProfileId !== undefined ? parentProfileId : undefined,
                arabicName: req.body.arabicName !== undefined ? req.body.arabicName : undefined,
                sessionId: sessionId !== undefined ? sessionId : undefined,
                subjectCategoryId: subjectCategoryId !== undefined ? subjectCategoryId : undefined
            }
        })
    }

    res.status(StatusCodes.OK).json({ msg: 'Student updated successfully' })
}

// ─── DELETE STUDENT ────────────────────────────────────────────────────────────
const deleteStudent = async (req, res) => {
    const { id } = req.params

    // Soft Delete User & Profile
    await prisma.$transaction([
        prisma.user.updateMany({
            where: { id, schoolId: req.user.schoolId },
            data: { isDeleted: true, deletedAt: new Date() }
        }),
        prisma.studentProfile.update({
            where: { userId: id },
            data: { isDeleted: true, deletedAt: new Date(), status: 'Deleted' }
        })
    ])

    // Log the deletion action
    await logTenantAction({
        schoolId: req.user.schoolId,
        userId: req.user.userId,
        action: 'DELETE_STUDENT',
        entityType: 'User/StudentProfile',
        entityId: id,
        ipAddress: req.ip
    })

    res.status(StatusCodes.OK).json({ msg: 'Student deleted successfully' })
}

// ─── PROMOTE STUDENTS ────────────────────────────────────────────────────────
const promoteStudents = async (req, res) => {
    const { studentIds, targetClassId, sessionId, status, notes } = req.body;
    
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'No students selected for promotion' });
    }

    if (!sessionId) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Target Academic Session is required' });
    }

    if (!status || !['PROMOTED', 'HELD_BACK', 'GRADUATED'].includes(status)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Valid promotion status is required' });
    }

    // Verify Target Class if not graduating
    if (status !== 'GRADUATED' && !targetClassId) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Target class is required for non-graduating students' });
    }

    const schoolId = req.user.schoolId;

    // Fetch students to ensure they exist and belong to the school
    const students = await prisma.studentProfile.findMany({
        where: { id: { in: studentIds }, schoolId, isDeleted: false },
        select: { id: true, classId: true }
    });

    if (students.length === 0) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: 'No valid students found' });
    }

    // Prepare transaction
    const transactionOperations = [];

    // 1. Create PromotionHistory records
    const historyData = students.map(student => ({
        schoolId,
        studentId: student.id,
        fromClassId: student.classId,
        toClassId: status === 'GRADUATED' ? null : targetClassId,
        sessionId,
        promotedBy: req.user.userId,
        status,
        notes: notes || null
    }));

    transactionOperations.push(
        prisma.promotionHistory.createMany({
            data: historyData
        })
    );

    // 2. Update StudentProfiles
    for (const student of students) {
        const updateData = {
            sessionId // Always update session
        };

        if (status === 'GRADUATED') {
            updateData.status = 'Graduated';
            updateData.classId = null; // Remove from active class
        } else {
            updateData.classId = targetClassId;
        }

        transactionOperations.push(
            prisma.studentProfile.update({
                where: { id: student.id },
                data: updateData
            })
        );
    }

    // Execute Transaction
    await prisma.$transaction(transactionOperations);

    // Log the action
    await logTenantAction({
        schoolId: req.user.schoolId,
        userId: req.user.userId,
        action: 'PROMOTE_STUDENTS',
        entityType: 'StudentProfile',
        entityId: 'BATCH',
        metadata: {
            count: students.length,
            status,
            targetClassId,
            sessionId
        },
        ipAddress: req.ip
    });

    res.status(StatusCodes.OK).json({ msg: `Successfully processed ${students.length} students` });
}

module.exports = { addStudent, getAllStudents, getStudent, updateStudent, deleteStudent, promoteStudents }
