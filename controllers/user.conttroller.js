
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
            studentProfile: true,
            teacherProfile: true,
            parentProfile: true
        }
    })

    if (!user) {
        throw new CustomError.UnauthenticatedError('User no longer exists')
    }

    let schoolData = null;
    if (user.schoolId) {
        schoolData = await prisma.school.findUnique({
            where: { id: user.schoolId },
            include: {
                plan: true,
                featureFlags: true,
                group: { select: { id: true, name: true } }
            }
        });
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

module.exports = {
    getAllUsers,
    getSingleUser,
    showCurrentUser,
    updateUser,
    updateUserPassword,
    adminResetPassword
}
