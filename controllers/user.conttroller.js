
const prisma = require('../db/prisma');
const argon2 = require('argon2')
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { createTokenUser, attachCookiesToResponse, checkPermissions } = require('../utils')

const getAllUsers = async (req, res) => {
    // Only looking for users, filtering out password hash
    const users = await prisma.user.findMany({
        where: { role: 'STUDENT' }, // Default map to old 'user' role
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            createdAt: true,
            updatedAt: true
        }
    })
    res.status(StatusCodes.OK).json({ users })
}

const getSingleUser = async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            createdAt: true,
            updatedAt: true
        }
    })

    if (!user) {
        throw new CustomError.NotFoundError(`No user with id : ${req.params.id}`)
    }

    checkPermissions(req.user, user.id)
    res.status(StatusCodes.OK).json({ user })
}

const showCurrentUser = async (req, res) => {
    if (req.user.role === 'GROUP_ADMIN') {
        const admin = await prisma.groupAdmin.findUnique({
            where: { id: req.user.userId }
        });
        if (!admin) throw new CustomError.UnauthenticatedError('Admin no longer exists');
        return res.status(StatusCodes.OK).json({
            user: {
                id: admin.id,
                name: admin.name,
                email: admin.email,
                role: admin.role,
                groupId: admin.groupId
            }
        });
    }

    // We want the frontend to have the full rich data, including email and nested profiles
    const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            schoolId: true,
            branchId: true, // Phase 1/2
            studentProfile: true,
            teacherProfile: true,
            parentProfile: true,
            customRole: true,
            branch: { select: { id: true, name: true, code: true } } // Phase 2: include bound branch data
        }
    })

    if (!user) {
        throw new CustomError.UnauthenticatedError('User no longer exists')
    }

    if (user.role === 'TEACHER' && user.teacherProfile) {
        const formClasses = await prisma.class.findMany({
            where: { formTeacherId: user.teacherProfile.id, isDeleted: false },
            select: { id: true, name: true, sessionId: true }
        });
        user.teacherProfile.isFormTeacher = formClasses.length > 0;
        user.teacherProfile.formClasses = formClasses;
    }

    let schoolData = null;
    if (user.schoolId) {
        const school = await prisma.school.findUnique({
            where: { id: user.schoolId },
            include: {
                plan: true,
                featureFlags: true,
                group: { select: { id: true, name: true } }
            }
        });
        const schoolSettings = school ? await prisma.schoolSettings.findFirst({ where: { schoolId: user.schoolId } }) : null;
        schoolData = school ? { ...school, logoUrl: schoolSettings?.logoUrl || school.logoUrl, blockedFeatures: schoolSettings?.blockedFeatures || [] } : null;
    }

    res.status(StatusCodes.OK).json({ user: { ...user, school: schoolData } })
}

const updateUser = async (req, res) => {
    const { loginId, name, email } = req.body;

    if (!name || (!loginId && !email)) {
        throw new CustomError.BadRequestError('Please provide all values')
    }

    const currentLoginId = loginId || email;

    const currentUser = await prisma.user.findUnique({
        where: { id: req.user.userId }
    });

    let updateData = { name };
    
    // For admins, their login ID IS their email, so we update the email field.
    if (currentUser.role === 'ADMIN' || currentUser.role === 'SCHOOL_ADMIN' || currentUser.role === 'SCHOOL_SUPER_ADMIN' || currentUser.role === 'BRANCH_ADMIN' || currentUser.role === 'BRANCH_STAFF') {
        updateData.email = currentLoginId;
    }

    const user = await prisma.user.update({
        where: { id: req.user.userId },
        data: updateData
    });

    if (user.role === 'TEACHER') {
        await prisma.teacherProfile.updateMany({ where: { userId: user.id }, data: { employeeId: currentLoginId } });
    } else if (user.role === 'STUDENT') {
        await prisma.studentProfile.updateMany({ where: { userId: user.id }, data: { admissionNo: currentLoginId } });
    } else if (user.role === 'PARENT') {
        await prisma.parentProfile.updateMany({ where: { userId: user.id }, data: { parentId: currentLoginId } });
    }

    // Now return full user data just like showCurrentUser to refresh the frontend state accurately!
    const refreshedUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
            id: true, name: true, email: true, role: true, schoolId: true, branchId: true,
            studentProfile: true, teacherProfile: true, parentProfile: true, customRole: true,
            branch: { select: { id: true, name: true, code: true } }
        }
    });

    const tokenUser = createTokenUser(user)
    attachCookiesToResponse({ res, user: tokenUser })
    res.status(StatusCodes.OK).json({ user: refreshedUser })
}

const updateUserPassword = async (req, res) => {
    const { oldPassword, newPassword } = req.body

    if (!oldPassword || !newPassword) {
        throw new CustomError.BadRequestError('Please provide both values')
    }

    const user = await prisma.user.findUnique({
        where: { id: req.user.userId }
    })

    if (!user) {
        throw new CustomError.UnauthenticatedError('User not found for the provided token.')
    }

    const isPasswordCorrect = await argon2.verify(user.password, oldPassword)
    if (!isPasswordCorrect) {
        throw new CustomError.UnauthenticatedError('Invalid Credentials')
    }

    const hashedPassword = await argon2.hash(newPassword)

    await prisma.user.update({
        where: { id: req.user.userId },
        data: { password: hashedPassword }
    })

    res.status(StatusCodes.OK).json({ msg: 'Successfully updated password' })
}

const adminUpdateUserCredentials = async (req, res) => {
    const { id: targetUserId } = req.params;
    const { newPassword, newLoginId } = req.body;

    if (!newPassword && !newLoginId) {
        throw new CustomError.BadRequestError('Please provide a new password or new login ID to update');
    }

    const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        include: { teacherProfile: true, studentProfile: true, parentProfile: true }
    });

    if (!targetUser) throw new CustomError.NotFoundError(`No user found with id: ${targetUserId}`);

    if (targetUser.schoolId !== req.user.schoolId) {
        throw new CustomError.UnauthorizedError('You are not authorized to modify this user');
    }

    if (['SUPER_ADMIN', 'GROUP_ADMIN'].includes(targetUser.role)) {
        throw new CustomError.UnauthorizedError('Cannot modify credentials for super admins or group admins');
    }

    // Role-based restrictions
    if (req.user.role === 'TEACHER') {
        // Teacher can only edit students in their form class
        if (targetUser.role !== 'STUDENT') {
            throw new CustomError.UnauthorizedError('Teachers can only edit student credentials');
        }
        const teacherProfile = await prisma.teacherProfile.findFirst({ where: { userId: req.user.userId, isDeleted: false } });
        if (!teacherProfile) throw new CustomError.UnauthorizedError('Teacher profile not found');
        
        const studentProfile = targetUser.studentProfile;
        if (!studentProfile) throw new CustomError.NotFoundError('Student profile not found');

        const formClass = await prisma.class.findFirst({
            where: { id: studentProfile.classId, formTeacherId: teacherProfile.id, isDeleted: false }
        });

        if (!formClass) {
            throw new CustomError.UnauthorizedError('You can only edit credentials for students in your assigned form class');
        }
    }

    let updateData = {};
    if (newPassword) {
        if (newPassword.length < 6) throw new CustomError.BadRequestError('Password must be at least 6 characters');
        const argon2 = require('argon2');
        updateData.password = await argon2.hash(newPassword);
    }

    if (newLoginId) {
        // Update the login ID mapping for the specific role
        if (['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN', 'BRANCH_ADMIN', 'BRANCH_STAFF'].includes(targetUser.role)) {
            updateData.email = newLoginId;
        } else if (targetUser.role === 'TEACHER' && targetUser.teacherProfile) {
            await prisma.teacherProfile.update({
                where: { id: targetUser.teacherProfile.id },
                data: { employeeId: newLoginId }
            });
        } else if (targetUser.role === 'STUDENT' && targetUser.studentProfile) {
            await prisma.studentProfile.update({
                where: { id: targetUser.studentProfile.id },
                data: { admissionNo: newLoginId }
            });
        } else if (targetUser.role === 'PARENT' && targetUser.parentProfile) {
            await prisma.parentProfile.update({
                where: { id: targetUser.parentProfile.id },
                data: { parentId: newLoginId }
            });
        }
    }

    if (Object.keys(updateData).length > 0) {
        await prisma.user.update({
            where: { id: targetUserId },
            data: updateData
        });
    }

    res.status(StatusCodes.OK).json({ msg: 'User credentials updated successfully' });
}

// ─── RESTRICT / UNRESTRICT INDIVIDUAL USER ────────────────────────────────────
const restrictUser = async (req, res) => {
    const { id: targetUserId } = req.params;
    const { isRestricted, reason } = req.body;

    if (isRestricted === undefined) {
        throw new CustomError.BadRequestError('isRestricted (boolean) is required');
    }
    if (isRestricted && !reason) {
        throw new CustomError.BadRequestError('A restriction reason is required');
    }

    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!targetUser) throw new CustomError.NotFoundError(`No user found with id: ${targetUserId}`);
    if (targetUser.schoolId !== req.user.schoolId) {
        throw new CustomError.UnauthorizedError('Not authorized to restrict this user');
    }

    // Protect super admins from being restricted
    const PROTECTED_ROLES = ['SUPER_ADMIN', 'SCHOOL_SUPER_ADMIN', 'GROUP_ADMIN'];
    if (PROTECTED_ROLES.includes(targetUser.role)) {
        throw new CustomError.UnauthorizedError('This user account cannot be restricted');
    }

    const updated = await prisma.user.update({
        where: { id: targetUserId },
        data: {
            isRestricted: Boolean(isRestricted),
            restrictionReason: isRestricted ? reason.trim() : null,
            restrictedAt: isRestricted ? new Date() : null,
            restrictedById: isRestricted ? req.user.userId : null
        },
        select: { id: true, name: true, email: true, role: true, isRestricted: true, restrictionReason: true }
    });

    res.status(StatusCodes.OK).json({
        msg: `User ${isRestricted ? 'restricted' : 'unrestricted'} successfully`,
        user: updated
    });
};

// ─── BULK RESTRICT BY ROLE ────────────────────────────────────────────────────
const bulkRestrictUsers = async (req, res) => {
    const { role, isRestricted, reason } = req.body;

    if (!role) throw new CustomError.BadRequestError('role is required');
    if (isRestricted === undefined) throw new CustomError.BadRequestError('isRestricted (boolean) is required');
    if (isRestricted && !reason) throw new CustomError.BadRequestError('A restriction reason is required when restricting');

    const PROTECTED_ROLES = ['SUPER_ADMIN', 'SCHOOL_SUPER_ADMIN', 'GROUP_ADMIN'];
    if (PROTECTED_ROLES.includes(role)) {
        throw new CustomError.UnauthorizedError('That role cannot be bulk restricted');
    }

    const result = await prisma.user.updateMany({
        where: {
            schoolId: req.user.schoolId,
            role,
            isDeleted: false
        },
        data: {
            isRestricted: Boolean(isRestricted),
            restrictionReason: isRestricted ? reason.trim() : null,
            restrictedAt: isRestricted ? new Date() : null,
            restrictedById: isRestricted ? req.user.userId : null
        }
    });

    res.status(StatusCodes.OK).json({
        msg: `${result.count} ${role.toLowerCase()}(s) ${isRestricted ? 'restricted' : 'unrestricted'} successfully`,
        count: result.count
    });
};

module.exports = {
    getAllUsers,
    getSingleUser,
    showCurrentUser,
    updateUser,
    updateUserPassword,
    adminUpdateUserCredentials,
    restrictUser,
    bulkRestrictUsers
}
