
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
        schoolData = school ? { ...school, logoUrl: schoolSettings?.logoUrl || null, blockedFeatures: schoolSettings?.blockedFeatures || [] } : null;
    }

    res.status(StatusCodes.OK).json({ user: { ...user, school: schoolData } })
}

const updateUser = async (req, res) => {
    const { email, name } = req.body

    if (!email || !name) {
        throw new CustomError.BadRequestError('Please provide all values')
    }

    // Update user via Prisma
    const user = await prisma.user.update({
        where: { id: req.user.userId },
        data: { email, name }
    })

    const tokenUser = createTokenUser(user)
    attachCookiesToResponse({ res, user: tokenUser })
    res.status(StatusCodes.OK).json({ user: tokenUser })
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

const adminResetPassword = async (req, res) => {
    const { id: targetUserId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
        throw new CustomError.BadRequestError('Please provide a valid newPassword (min 6 characters)');
    }

    // Ensure the target user belongs to the same school as the admin
    const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId }
    });

    if (!targetUser) {
        throw new CustomError.NotFoundError(`No user found with id: ${targetUserId}`);
    }

    if (targetUser.schoolId !== req.user.schoolId) {
        throw new CustomError.UnauthorizedError('You are not authorized to reset the password for this user');
    }

    // Do not allow resetting SUPER_ADMIN or GROUP_ADMIN passwords via this standard School Admin route
    if (['SUPER_ADMIN', 'GROUP_ADMIN'].includes(targetUser.role)) {
        throw new CustomError.UnauthorizedError('Cannot reset password for super admins or group admins');
    }

    const hashedPassword = await argon2.hash(newPassword);

    await prisma.user.update({
        where: { id: targetUserId },
        data: { password: hashedPassword }
    });

    res.status(StatusCodes.OK).json({ msg: 'User password has been successfully reset' });
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
    adminResetPassword,
    restrictUser,
    bulkRestrictUsers
}
