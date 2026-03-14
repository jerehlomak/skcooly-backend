
const prisma = require('../db/prisma');
const argon2 = require('argon2');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { logTenantAction } = require('../services/audit-log.service')

const generateRandomPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
};

// ─── ADD TEACHER ───────────────────────────────────────────────────────────────
const addTeacher = async (req, res) => {
    const { name, email, department, phone, gender, dateOfBirth, address, qualification, salary, subjects, bankName, accountName, accountNumber } = req.body;

    if (!name || !gender || !email) {
        throw new CustomError.BadRequestError('Please provide name, email, and gender');
    }

    const emailAlreadyExist = await prisma.user.findUnique({
        where: { email },
    });

    if (emailAlreadyExist) {
        throw new CustomError.BadRequestError(`User with email "${email}" already exists. Please choose a different email.`);
    }

    const currentYear = new Date().getFullYear();

    const lastTeacher = await prisma.teacherProfile.findFirst({
        where: { employeeId: { startsWith: `TCH-${currentYear}-` }, schoolId: req.user.schoolId },
        orderBy: { hireDate: 'desc' }
    });

    let sequence = 1;
    if (lastTeacher && lastTeacher.employeeId) {
        const parts = lastTeacher.employeeId.split('-');
        if (parts.length === 3) sequence = parseInt(parts[2]) + 1;
    }

    const formattedSeq = sequence.toString().padStart(4, '0');
    const employeeId = `TCH-${currentYear}-${formattedSeq}`;

    // Auto-generate password securely
    const generatedPassword = generateRandomPassword();
    const hashedPassword = await argon2.hash(generatedPassword);

    const newTeacher = await prisma.$transaction(async (tx) => {
        return await tx.user.create({
            data: {
                name,
                email, // Use provided email
                password: hashedPassword,
                role: 'TEACHER',
                schoolId: req.user.schoolId,
                teacherProfile: {
                    create: {
                        schoolId: req.user.schoolId,
                        employeeId,
                        department: department || null,
                        phone: phone || null,
                        gender,
                        status: 'Active',
                        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
                        address: address || null,
                        qualification: qualification || null,
                        salary: salary ? parseFloat(salary) : null,
                        bankName: bankName || null,
                        accountName: accountName || null,
                        accountNumber: accountNumber || null,
                        subjectsTaught: subjects || null
                    }
                }
            },
            select: { id: true, name: true, email: true, role: true, teacherProfile: true }
        });
    });

    res.status(StatusCodes.CREATED).json({
        msg: 'Teacher account created securely',
        teacher: newTeacher,
        credentials: { employeeId, loginEmail: email, generatedPassword }
    });
};

// ─── GET ALL TEACHERS ──────────────────────────────────────────────────────────
const getAllTeachers = async (req, res) => {
    const teachers = await prisma.teacherProfile.findMany({
        where: { schoolId: req.user.schoolId, isDeleted: false },
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
        orderBy: { hireDate: 'desc' }
    });
    res.status(StatusCodes.OK).json({ teachers, count: teachers.length });
};

// ─── GET SINGLE TEACHER ───────────────────────────────────────────────────────
const getTeacher = async (req, res) => {
    const { id } = req.params; // User.id
    const user = await prisma.user.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false },
        include: { teacherProfile: true }
    });
    if (!user || !user.teacherProfile) {
        throw new CustomError.NotFoundError(`No teacher found with id: ${id}`);
    }
    res.status(StatusCodes.OK).json({ teacher: user.teacherProfile, user });
};

// ─── UPDATE TEACHER ───────────────────────────────────────────────────────────
const updateTeacher = async (req, res) => {
    const { id } = req.params; // User.id
    const { name, email, department, phone, gender, status, dateOfBirth, address, qualification, salary, subjects, bankName, accountName, accountNumber } = req.body;

    if (email) {
        const existingEmailUser = await prisma.user.findFirst({
            where: { email, id: { not: id } }
        });
        if (existingEmailUser) {
            throw new CustomError.BadRequestError(`Email "${email}" is already taken by another user.`);
        }
    }

    await prisma.user.updateMany({
        where: { id, schoolId: req.user.schoolId },
        data: {
            ...(name && { name }),
            ...(email && { email }),
        }
    });

    if (department !== undefined || phone !== undefined || gender || status || dateOfBirth || address !== undefined || qualification !== undefined || salary !== undefined || bankName !== undefined || accountName !== undefined || accountNumber !== undefined || subjects !== undefined) {
        await prisma.teacherProfile.update({
            where: { userId: id },
            data: {
                ...(department !== undefined && { department }),
                ...(phone !== undefined && { phone }),
                ...(gender && { gender }),
                ...(status && { status }),
                ...(dateOfBirth && { dateOfBirth: new Date(dateOfBirth) }),
                ...(address !== undefined && { address }),
                ...(qualification !== undefined && { qualification }),
                ...(salary !== undefined && { salary: salary ? parseFloat(salary) : null }),
                ...(bankName !== undefined && { bankName }),
                ...(accountName !== undefined && { accountName }),
                ...(accountNumber !== undefined && { accountNumber }),
                ...(subjects !== undefined && { subjects })
            }
        });
    }

    res.status(StatusCodes.OK).json({ msg: 'Teacher updated successfully' });
};

// ─── DELETE TEACHER ───────────────────────────────────────────────────────────
const deleteTeacher = async (req, res) => {
    const { id } = req.params;

    // Soft Delete User & Teacher Profile
    await prisma.$transaction([
        prisma.user.updateMany({
            where: { id, schoolId: req.user.schoolId },
            data: { isDeleted: true, deletedAt: new Date() }
        }),
        prisma.teacherProfile.update({
            where: { userId: id },
            data: { isDeleted: true, deletedAt: new Date(), status: 'Deleted' }
        })
    ]);

    // Log the deletion action
    await logTenantAction({
        schoolId: req.user.schoolId,
        userId: req.user.userId,
        action: 'DELETE_TEACHER',
        entityType: 'User/TeacherProfile',
        entityId: id,
        ipAddress: req.ip
    });

    res.status(StatusCodes.OK).json({ msg: 'Teacher deleted securely' });
};

// ─── GET MY CLASSES & SUBJECTS (TEACHER PORTAL) ─────────────────────────────
const getMyClasses = async (req, res) => {
    const userId = req.user.userId;

    const teacher = await prisma.teacherProfile.findUnique({
        where: { userId }
    });
    if (!teacher) throw new CustomError.NotFoundError('Teacher profile not found');

    // Find all ClassSubjects where this teacher is assigned (specific to exactly that class and subject)
    const classSubjects = await prisma.classSubject.findMany({
        where: { teacherId: teacher.id },
        select: { classId: true, subjectId: true }
    });

    const classIds = [...new Set(classSubjects.map(cs => cs.classId))];

    // Fetch full Class details
    const classes = await prisma.class.findMany({
        where: { id: { in: classIds } },
        include: {
            subjects: { include: { subject: true } }
        }
    });

    // To add student counts, we do it in code
    const enhancedClasses = await Promise.all(classes.map(async (cls) => {
        // Count students assigned to this specific class arm (by classId)
        // Falls back to classLevel count for students not yet migrated to classId
        const byArm = await prisma.studentProfile.count({
            where: { classId: cls.id, status: 'Active' }
        });
        const byLevel = byArm === 0
            ? await prisma.studentProfile.count({ where: { classLevel: cls.level, status: 'Active' } })
            : 0;
        const studentCount = byArm > 0 ? byArm : byLevel;

        // Which subjects does this teacher teach IN THIS SPECIFIC CLASS? 
        // Based on the classSubjects we queried at the top
        const mySubjectsForThisClass = classSubjects
            .filter(cs => cs.classId === cls.id)
            .map(cs => cls.subjects.find(s => s.subjectId === cs.subjectId)?.subject)
            .filter(Boolean);

        return {
            ...cls,
            studentCount,
            mySubjects: mySubjectsForThisClass.map(ms => ({ id: ms.id, name: ms.name }))
        };
    }));

    res.status(StatusCodes.OK).json({ classes: enhancedClasses });
};

const getMySubjects = async (req, res) => {
    const userId = req.user.userId;

    const teacher = await prisma.teacherProfile.findUnique({
        where: { userId }
    });
    if (!teacher) throw new CustomError.NotFoundError('Teacher profile not found');

    // Find all ClassSubjects to see purely what classes this teacher actively teaches
    const myClassSubjects = await prisma.classSubject.findMany({
        where: { teacherId: teacher.id },
        include: {
            class: true,
            subject: true
        }
    });

    // Group these exactly by Subject so we can return them as "My Subjects"
    // grouping logic:
    const subjectMap = {};
    for (const cs of myClassSubjects) {
        if (!subjectMap[cs.subjectId]) {
            subjectMap[cs.subjectId] = {
                ...cs.subject,
                classes: []
            };
        }
        subjectMap[cs.subjectId].classes.push({
            class: cs.class
        });
    }
    const subjectsObj = Object.values(subjectMap);

    // Format for frontend
    const enhancedSubjects = await Promise.all(subjectsObj.map(async (sub) => {
        const enhancedClasses = await Promise.all(sub.classes.map(async (cs) => {
            const studentCount = await prisma.studentProfile.count({
                where: { classLevel: cs.class.level, status: 'Active' }
            });
            return {
                classLevel: cs.class.level,
                classArm: cs.class.name,
                students: studentCount
            };
        }));

        const totalStudents = enhancedClasses.reduce((sum, cls) => sum + cls.students, 0);

        return {
            ...sub,
            assignedClasses: enhancedClasses,
            totalStudents
        };
    }));

    res.status(StatusCodes.OK).json({ subjects: enhancedSubjects });
};


// ─── GET MY FORM CLASS (TEACHER PORTAL — for Attendance) ────────────────────
// Returns ONLY the class(es) where this teacher is assigned as Form Teacher
const getMyFormClass = async (req, res) => {
    const userId = req.user.userId;

    const teacher = await prisma.teacherProfile.findUnique({ where: { userId } });
    if (!teacher) throw new CustomError.NotFoundError('Teacher profile not found');

    const formClasses = await prisma.class.findMany({
        where: { formTeacherId: teacher.id },
        orderBy: { name: 'asc' },
    });

    res.status(StatusCodes.OK).json({ formClasses });
};


module.exports = { addTeacher, getAllTeachers, getTeacher, updateTeacher, deleteTeacher, getMyClasses, getMySubjects, getMyFormClass };
