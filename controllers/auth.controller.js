
const prisma = require('../db/prisma');
const argon2 = require('argon2')
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { createJWT, isTokenValid, attachCookiesToResponse, createTokenUser } = require('../utils')

const register = async (req, res) => {
    const { email, name, password } = req.body

    // Check if user already exists
    const emailAlreadyExist = await prisma?.user?.findUnique({
        where: { email }
    })

    if (emailAlreadyExist) {
        throw new CustomError.BadRequestError('Email already exists')
    }

    // Hash password with Argon2
    const hashedPassword = await argon2.hash(password)

    // Securely create user - Admins must be created differently or seeded. Default role is STUDENT.
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
    const { loginId, password, role } = req.body

    if (!loginId || !password || !role) {
        throw new CustomError.BadRequestError('Please provide login credentials and role')
    }

    let user = null;

    if (role === 'ADMIN') {
        user = await prisma.user.findUnique({
            where: { email: loginId },
            include: { studentProfile: true, teacherProfile: true, parentProfile: true }
        })
    } else if (role === 'STUDENT') {
        const profile = await prisma.studentProfile.findUnique({
            where: { admissionNo: loginId },
            include: { user: { include: { studentProfile: true, teacherProfile: true, parentProfile: true } } }
        })
        user = profile ? profile.user : null;
    } else if (role === 'TEACHER') {
        const profile = await prisma.teacherProfile.findUnique({
            where: { employeeId: loginId },
            include: { user: { include: { studentProfile: true, teacherProfile: true, parentProfile: true } } }
        })
        user = profile ? profile.user : null;
    } else if (role === 'PARENT') {
        const profile = await prisma.parentProfile.findUnique({
            where: { parentId: loginId },
            include: { user: { include: { studentProfile: true, teacherProfile: true, parentProfile: true } } }
        })
        user = profile ? profile.user : null;
    } else {
        throw new CustomError.BadRequestError('Invalid role specified')
    }

    if (!user) {
        throw new CustomError.UnauthenticatedError('Invalid Credentials')
    }

    // Compare passwords with Argon2
    const isPasswordCorrect = await argon2.verify(user.password, password)

    if (!isPasswordCorrect) {
        throw new CustomError.UnauthenticatedError('Invalid Credentials')
    }

    const tokenUser = createTokenUser(user)
    attachCookiesToResponse({ res, user: tokenUser })

    // Return the full user object (excluding password) to the frontend context immediately
    const userContextData = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        studentProfile: user.studentProfile,
        teacherProfile: user.teacherProfile,
        parentProfile: user.parentProfile,
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
    const { email, name, password, adminSecret } = req.body

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
            role: 'ADMIN'
        }
    })

    const tokenUser = createTokenUser(user)
    attachCookiesToResponse({ res, user: tokenUser })

    res.status(StatusCodes.CREATED).json({ user: tokenUser })
}

module.exports = {
    register,
    login,
    logout,
    registerAdmin
}