
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
    // We want the frontend to have the full rich data, including email and nested profiles
    const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            studentProfile: true,
            teacherProfile: true,
            parentProfile: true
        }
    })

    if (!user) {
        throw new CustomError.UnauthenticatedError('User no longer exists')
    }

    res.status(StatusCodes.OK).json({ user })
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

module.exports = {
    getAllUsers,
    getSingleUser,
    showCurrentUser,
    updateUser,
    updateUserPassword
}
