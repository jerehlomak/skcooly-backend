
const prisma = require('../db/prisma');
const argon2 = require('argon2')
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { createTokenUser, attachCookiesToResponse } = require('../utils')
const { resolveUserAccess } = require('../services/permissions.service')

const register = async (req, res) => {
    const { email, name, password } = req.body

    const emailAlreadyExist = await prisma?.user?.findUnique({
        where: { email }
    })

    if (emailAlreadyExist) {
        throw new CustomError.BadRequestError('Email already exists')
    }

    const hashedPassword = await argon2.hash(password)

    const user = await prisma.user.create({
        data: {
            email,
            name,
            password: hashedPassword,
            role: 'STUDENT'
        }
    })

    const tokenUser = createTokenUser(user)
    attachCookiesToResponse({ res, user: tokenUser })

    res.status(StatusCodes.CREATED).json({ user: tokenUser })
}

const login = async (req, res) => {
    let { loginId, password, role, schoolCode } = req.body
    
    if (loginId) loginId = loginId.trim()

    if (!loginId || !password || !role) {
        throw new CustomError.BadRequestError('Please provide login credentials and role')
    }

    if (!schoolCode) {
        throw new CustomError.BadRequestError('Please provide your School ID')
    }

    // First, find the school by schoolCode
    const school = await prisma.school.findUnique({
        where: { schoolCode: schoolCode.toUpperCase().trim() },
        include: { plan: true, featureFlags: true, group: { select: { id: true, name: true } } }
    })

    // Fetch SchoolSettings for logoUrl and blockedFeatures
    const schoolSettings = school ? await prisma.schoolSettings.findFirst({ where: { schoolId: school.id } }) : null;

    if (!school) {
        throw new CustomError.UnauthenticatedError('Invalid School ID')
    }

    if (school.status === 'SUSPENDED') {
        throw new CustomError.UnauthenticatedError('This school account has been suspended. Please contact platform support.')
    }

    let user = null;

    if (role === 'ADMIN' || role === 'SCHOOL_SUPER_ADMIN' || role === 'SCHOOL_ADMIN') {
        // All school-level admin roles log in by email
        user = await prisma.user.findFirst({
            where: { email: loginId, schoolId: school.id, isDeleted: false },
            include: { studentProfile: true, teacherProfile: true, parentProfile: true }
        })
    } else if (role === 'BRANCH_ADMIN' || role === 'BRANCH_STAFF') {
        // Branch-level staff also log in by email
        user = await prisma.user.findFirst({
            where: { email: loginId, schoolId: school.id, isDeleted: false },
            include: { studentProfile: true, teacherProfile: true, parentProfile: true }
        })
    } else if (role === 'STUDENT') {
        const profile = await prisma.studentProfile.findFirst({
            where: { admissionNo: loginId, schoolId: school.id, isDeleted: false },
            include: { user: { include: { studentProfile: true, teacherProfile: true, parentProfile: true } } }
        })
        user = profile ? profile.user : null;
    } else if (role === 'TEACHER') {
        const profile = await prisma.teacherProfile.findFirst({
            where: { employeeId: loginId, schoolId: school.id, isDeleted: false },
            include: { user: { include: { studentProfile: true, teacherProfile: true, parentProfile: true } } }
        })
        user = profile ? profile.user : null;
    } else if (role === 'PARENT') {
        const profile = await prisma.parentProfile.findFirst({
            where: { parentId: loginId, schoolId: school.id, isDeleted: false },
            include: { user: { include: { studentProfile: true, teacherProfile: true, parentProfile: true } } }
        })
        user = profile ? profile.user : null;
    } else {
        throw new CustomError.BadRequestError('Invalid role specified')
    }

    if (!user) {
        throw new CustomError.UnauthenticatedError('Invalid Credentials')
    }

    const isPasswordCorrect = await argon2.verify(user.password, password)

    if (!isPasswordCorrect) {
        throw new CustomError.UnauthenticatedError('Invalid Credentials')
    }

    // Check if the account has been restricted by the school admin
    if (user.isRestricted) {
        const reason = user.restrictionReason || 'No reason provided';
        return res.status(403).json({
            isRestricted: true,
            msg: `Your portal has been restricted. Please contact the school administration.`,
            reason
        });
    }

    const tokenUser = createTokenUser(user)
    attachCookiesToResponse({ res, user: tokenUser })

    if (user.role === 'TEACHER' && user.teacherProfile) {
        const formClasses = await prisma.class.findMany({
            where: { formTeacherId: user.teacherProfile.id, isDeleted: false },
            select: { id: true, name: true, sessionId: true }
        });
        user.teacherProfile.isFormTeacher = formClasses.length > 0;
        user.teacherProfile.formClasses = formClasses;
    }

    const { permissions, enabledDashboards } = await resolveUserAccess(user.id)

    const userContextData = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        schoolId: user.schoolId || null,
        branchId: user.branchId || null, // Phase 1: null for school-scope, set for branch users
        customRoleId: user.customRoleId || null, // RBAC: client uses this to know the user is role-constrained
        school: { ...school, blockedFeatures: schoolSettings?.blockedFeatures || [] },
        studentProfile: user.studentProfile,
        teacherProfile: user.teacherProfile,
        parentProfile: user.parentProfile,
        permissions,
        enabledDashboards,
    }

    res.status(StatusCodes.OK).json({ user: userContextData })
}

const logout = async (req, res) => {
    res.cookie('token', '', {
        httpOnly: true,
        expires: new Date(Date.now())
    })
    res.status(StatusCodes.OK).json({ msg: 'user logged out' })
}

// Secure route to register an initial admin (needs an environment secret in production)
const registerAdmin = async (req, res) => {
    const { email, name, password, adminSecret, schoolId } = req.body

    if (adminSecret !== process.env.ADMIN_SETUP_SECRET) {
        throw new CustomError.UnauthorizedError('Unauthorized to create admin account')
    }

    const emailAlreadyExist = await prisma.user.findUnique({
        where: { email }
    })

    if (emailAlreadyExist) {
        throw new CustomError.BadRequestError('Email already exists')
    }

    const hashedPassword = await argon2.hash(password)

    const user = await prisma.user.create({
        data: {
            email,
            name,
            password: hashedPassword,
            role: 'ADMIN',
            schoolId: schoolId || null,
        }
    })

    const tokenUser = createTokenUser(user)
    attachCookiesToResponse({ res, user: tokenUser })

    res.status(StatusCodes.CREATED).json({ user: tokenUser })
}

const resetPasswordWithKey = async (req, res) => {
    const { loginId, role, schoolCode, recoveryKey, newPassword } = req.body;

    if (!loginId || !role || !schoolCode || !recoveryKey || !newPassword) {
        throw new CustomError.BadRequestError('Please provide all required fields');
    }

    // Find the school by schoolCode
    const school = await prisma.school.findUnique({
        where: { schoolCode: schoolCode.toUpperCase().trim() }
    });

    if (!school) {
        throw new CustomError.UnauthenticatedError('Invalid School ID');
    }

    if (school.status === 'SUSPENDED') {
        throw new CustomError.UnauthenticatedError('This school account has been suspended. Please contact platform support.');
    }

    let user = null;

    if (role === 'ADMIN' || role === 'SCHOOL_SUPER_ADMIN' || role === 'SCHOOL_ADMIN' || role === 'BRANCH_ADMIN' || role === 'BRANCH_STAFF') {
        user = await prisma.user.findFirst({
            where: { email: loginId, schoolId: school.id, isDeleted: false }
        });
    } else if (role === 'STUDENT') {
        const profile = await prisma.studentProfile.findFirst({
            where: { admissionNo: loginId, schoolId: school.id, isDeleted: false },
            include: { user: true }
        });
        user = profile ? profile.user : null;
    } else if (role === 'TEACHER') {
        const profile = await prisma.teacherProfile.findFirst({
            where: { employeeId: loginId, schoolId: school.id, isDeleted: false },
            include: { user: true }
        });
        user = profile ? profile.user : null;
    } else if (role === 'PARENT') {
        const profile = await prisma.parentProfile.findFirst({
            where: { parentId: loginId, schoolId: school.id, isDeleted: false },
            include: { user: true }
        });
        user = profile ? profile.user : null;
    } else {
        throw new CustomError.BadRequestError('Invalid role specified');
    }

    if (!user) {
        throw new CustomError.UnauthenticatedError('Invalid User details');
    }

    if (!user.recoveryKey || user.recoveryKey !== recoveryKey) {
        throw new CustomError.UnauthenticatedError('Invalid Recovery Key');
    }

    if (user.recoveryKeyExpires && new Date() > user.recoveryKeyExpires) {
        throw new CustomError.UnauthenticatedError('Recovery Key has expired');
    }

    const hashedPassword = await argon2.hash(newPassword);

    await prisma.user.update({
        where: { id: user.id },
        data: {
            password: hashedPassword,
            recoveryKey: null,
            recoveryKeyExpires: null
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Password reset successfully' });
};

const switchSchool = async (req, res) => {
    const { targetSchoolId } = req.body;
    const user = req.user;

    if (!targetSchoolId) {
        throw new CustomError.BadRequestError('Target school ID is required');
    }

    if (user.role !== 'SCHOOL_SUPER_ADMIN' && user.role !== 'ADMIN') {
        throw new CustomError.UnauthorizedError('You do not have permission to switch branches');
    }

    // Determine the true main school ID from DB to prevent branching off a branch infinitely
    const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
    
    // If the user is currently using a branch token, originalSchoolId is available.
    // Otherwise, they are on their main school.
    const mainSchoolId = user.originalSchoolId || dbUser.schoolId;

    if (!mainSchoolId) {
        throw new CustomError.BadRequestError('User does not belong to a school');
    }

    let targetSchool;
    let isReturningToMain = false;

    if (targetSchoolId === mainSchoolId) {
        isReturningToMain = true;
        targetSchool = await prisma.school.findUnique({
            where: { id: mainSchoolId },
            include: { plan: true, featureFlags: true, group: { select: { id: true, name: true } } }
        });
    } else {
        targetSchool = await prisma.school.findFirst({
            where: { id: targetSchoolId, parentId: mainSchoolId },
            include: { plan: true, featureFlags: true, group: { select: { id: true, name: true } } }
        });
    }

    // Fetch SchoolSettings for the target school
    const targetSchoolSettings = targetSchool ? await prisma.schoolSettings.findFirst({ where: { schoolId: targetSchool.id } }) : null;

    if (!targetSchool) {
        throw new CustomError.NotFoundError('Branch not found or access denied');
    }

    const tokenUser = createTokenUser(dbUser);
    
    // Overwrite the token's schoolId to the target school
    tokenUser.schoolId = targetSchool.id;
    
    // If not returning to main, we need to remember the main school ID
    if (!isReturningToMain) {
        tokenUser.originalSchoolId = mainSchoolId;
    }

    attachCookiesToResponse({ res, user: tokenUser });

    const userContextData = {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role,
        schoolId: targetSchool.id,
        originalSchoolId: isReturningToMain ? undefined : mainSchoolId,
        branchId: dbUser.branchId || null,
        school: { ...targetSchool, blockedFeatures: targetSchoolSettings?.blockedFeatures || [] },
    };

    res.status(StatusCodes.OK).json({ user: userContextData });
};

module.exports = {
    register,
    login,
    logout,
    registerAdmin,
    resetPasswordWithKey,
    switchSchool
}
