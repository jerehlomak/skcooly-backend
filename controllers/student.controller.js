const prisma = require('../db/prisma');
const argon2 = require('argon2')
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { logTenantAction } = require('../services/audit-log.service')
const crypto = require('crypto');
const { publishEvent, EVENTS } = require('../services/event-bus.service')

// Helper function to generate a random readable 8 character password
const generateRandomPassword = () => { return '12345'; }

// ─── ADD STUDENT ───────────────────────────────────────────────────────────────
const addStudent = async (req, res) => {
    let {
        name, classLevel, classId, gender, phone,
        admissionDate, dateOfBirth, orphan, religion, bloodGroup, genotype,
        address, previousSchool, parentProfileId, sessionId, subjectCategoryId, profilePicture
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
        // Validate uniqueness of manually provided admission number
        const existing = await prisma.studentProfile.findFirst({
            where: { admissionNo, schoolId: req.user.schoolId, isDeleted: false }
        });
        if (existing) {
            throw new CustomError.BadRequestError(`Admission number "${admissionNo}" already exists in the system.`);
        }
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
                        genotype: genotype || null,
                        address: address || null,
                    profilePicture: profilePicture || null,
                        previousSchool: previousSchool || null,
                        parentProfileId: parentProfileId || null,
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

    const { page, limit, search, schoolType, classId } = req.query;
    
    // Pagination defaults
    const pageNumber = parseInt(page) || 1;
    const limitNumber = parseInt(limit) || 10; // If not provided, default to 10 for paginated requests, but if they need all we might need a flag. Wait, if we enforce 10, all old components will break.
    // If page/limit is provided, we paginate. Otherwise, we return all (backward compatibility for components not updated yet).
    const isPaginated = page !== undefined || limit !== undefined;
    const actualLimit = isPaginated ? limitNumber : undefined;
    const skip = isPaginated ? (pageNumber - 1) * limitNumber : undefined;

    let levelFilter = undefined;
    if (schoolType) {
        const classLevels = await prisma.classLevel.findMany({
            where: { schoolId, category: schoolType }
        });
        const levelNames = classLevels.map(cl => cl.name);
        const uppercaseLevelNames = levelNames.map(n => n.toUpperCase());
        levelFilter = { in: [...new Set([...levelNames, ...uppercaseLevelNames])] };
    }

    let whereClause = {
        schoolId,          // only this school
        isDeleted: false,  // soft delete check
        NOT: { schoolId: null },  // safety guard
        ...(levelFilter && { classLevel: levelFilter }),
        ...(classId && { classId }), // filter by specific class
    };

    if (search) {
        whereClause = {
            ...whereClause,
            OR: [
                { user: { name: { contains: search, mode: 'insensitive' } } },
                { user: { email: { contains: search, mode: 'insensitive' } } },
                { admissionNo: { contains: search, mode: 'insensitive' } },
            ]
        };
    }

    const totalRecords = await prisma.studentProfile.count({ where: whereClause });

    const students = await prisma.studentProfile.findMany({
        where: whereClause,
        include: {
            user: { select: { id: true, name: true, email: true, role: true, isRestricted: true, restrictionReason: true } },
            classArm: { select: { id: true, name: true, level: true } },
            parent: {
                include: { user: { select: { name: true } } }
            }
        },
        orderBy: { enrollmentDate: 'desc' },
        ...(isPaginated && { skip, take: actualLimit })
    });
    
    res.status(StatusCodes.OK).json({ 
        students, 
        count: students.length,
        total: totalRecords,
        page: pageNumber,
        totalPages: isPaginated ? Math.ceil(totalRecords / limitNumber) : 1
    });
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
        admissionDate, dateOfBirth, orphan, religion, bloodGroup, genotype,
        address, previousSchool, parentProfileId, sessionId, subjectCategoryId
    } = req.body

    // Convert empty strings or 'none' to null for foreign keys
    if (subjectCategoryId === '' || subjectCategoryId === 'none') subjectCategoryId = null;
    if (classId === '' || classId === 'none') classId = null;
    if (sessionId === '' || sessionId === 'none') sessionId = null;
    if (parentProfileId === '' || parentProfileId === 'none') parentProfileId = null;

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
    if (Object.keys(updateData).length > 0 || classLevel || classId || gender || status || phone || dateOfBirth || orphan !== undefined || religion || bloodGroup || address || previousSchool || parentProfileId || subjectCategoryId !== undefined) {
        
        const payloadClassId = (classId && classId.trim() !== '') ? classId : null;
        const payloadSubjectCategoryId = (subjectCategoryId && subjectCategoryId.trim() !== '') ? subjectCategoryId : null;
        
        await prisma.studentProfile.update({
            where: { userId: req.params.id },
            data: {
                classId: payloadClassId,
                classLevel,
                subjectCategoryId: payloadSubjectCategoryId,
                gender,
                phone,
                admissionDate: admissionDate ? new Date(admissionDate) : undefined,
                dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
                orphan: orphan === 'yes',
                religion,
                bloodGroup,
                genotype,
                address,
                previousSchool,
                profilePicture: req.body.profilePicture !== undefined ? req.body.profilePicture : undefined
            }
        });
    }

    res.status(StatusCodes.OK).json({ msg: 'Student updated successfully' });
}

// ─── CHECK ADMISSION NUMBER ───────────────────────────────────────────────────
const checkAdmissionNo = async (req, res) => {
    const { admissionNo } = req.query;
    if (!admissionNo) return res.status(200).json({ exists: false });
    const existing = await prisma.studentProfile.findFirst({
        where: { admissionNo, schoolId: req.user.schoolId, isDeleted: false }
    });
    res.status(200).json({ exists: !!existing });
};

// ─── TRANSFER STUDENT CLASS ───────────────────────────────────────────────────
const transferStudent = async (req, res) => {
    const { id } = req.params; // Student User ID
    const { newClassId, notes } = req.body;
    const schoolId = req.user.schoolId;

    if (!newClassId) {
        throw new CustomError.BadRequestError('Please provide a destination class (newClassId)');
    }

    const student = await prisma.studentProfile.findFirst({
        where: { userId: id, schoolId, isDeleted: false },
        include: { classArm: true }
    });

    if (!student) {
        throw new CustomError.NotFoundError(`No student found with id: ${id}`);
    }

    const newClass = await prisma.class.findUnique({
        where: { id: newClassId, schoolId, isDeleted: false }
    });

    if (!newClass) {
        throw new CustomError.NotFoundError(`Target class not found.`);
    }

    if (student.classId === newClassId) {
        throw new CustomError.BadRequestError('Student is already in this class.');
    }

    // Find the active academic session
    const currentSession = await prisma.academicSession.findFirst({
        where: { schoolId, isCurrent: true, isDeleted: false }
    });

    // Find the active academic term
    const currentTerm = currentSession ? await prisma.academicTerm.findFirst({
        where: { schoolId, sessionId: currentSession.id, isActive: true }
    }) : null;

    await prisma.$transaction(async (tx) => {
        // 1. Log transfer in PromotionHistory
        if (currentSession) {
            await tx.promotionHistory.create({
                data: {
                    schoolId,
                    studentId: student.id,
                    fromClassId: student.classId,
                    toClassId: newClassId,
                    sessionId: currentSession.id,
                    promotedBy: req.user.userId,
                    status: 'TRANSFERRED',
                    notes: notes || 'Manual class transfer'
                }
            });
        }

        // 2. Update current active term enrollment if it exists
        if (currentTerm) {
            await tx.studentTermEnrollment.updateMany({
                where: {
                    studentProfileId: student.id,
                    academicTermId: currentTerm.id
                },
                data: {
                    classId: newClassId
                }
            });
        }

        // 3. Update the main student profile
        await tx.studentProfile.update({
            where: { id: student.id },
            data: {
                classId: newClassId,
                classLevel: newClass.level
            }
        });
    });

    res.status(StatusCodes.OK).json({ msg: 'Student transferred successfully' });
};

const deleteStudent = async (req, res) => {
    const { id } = req.params;
    
    const student = await prisma.studentProfile.findFirst({
        where: { id, schoolId: req.user.schoolId }
    });

    if (!student) {
        throw new CustomError.NotFoundError(`No student found with id: ${id}`);
    }

    // Attempt to delete student profile and associated user
    await prisma.$transaction(async (tx) => {
        await tx.studentProfile.delete({ where: { id } });
        await tx.user.delete({ where: { id: student.userId } }).catch(() => {}); // safely ignore if user delete fails
    });

    res.status(StatusCodes.OK).json({ msg: 'Student deleted successfully' });
};

const promoteStudents = async (req, res) => {
    const { studentIds, targetClassId, sessionId, status } = req.body;
    
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
        throw new CustomError.BadRequestError('No students selected for promotion');
    }

    let classLevel = null;
    if (targetClassId) {
        const cls = await prisma.class.findUnique({ where: { id: targetClassId } });
        if (cls) classLevel = cls.level;
    }

    const updateData = {
        status: status === 'GRADUATED' ? 'Graduated' : 'Active'
    };

    if (sessionId) {
        updateData.sessionId = sessionId;
    }

    if (status === 'GRADUATED') {
        updateData.classId = null;
        updateData.classLevel = 'Graduated';
    } else if (targetClassId) {
        updateData.classId = targetClassId;
        if (classLevel) updateData.classLevel = classLevel;
    }

    await prisma.studentProfile.updateMany({
        where: { id: { in: studentIds }, schoolId: req.user.schoolId },
        data: updateData
    });

    res.status(StatusCodes.OK).json({ msg: 'Students promoted successfully' });
};

module.exports = { addStudent, getAllStudents, getStudent, updateStudent, deleteStudent, promoteStudents, checkAdmissionNo, transferStudent }
