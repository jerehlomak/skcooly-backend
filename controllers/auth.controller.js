
const prisma = require('../db/prisma');
const argon2 = require('argon2')
const { StatusCodes } = require('http-status-codes')
const CustomError = require('../errors')
const { createTokenUser, attachCookiesToResponse } = require('../utils')

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
    const { loginId, password, role, schoolCode } = req.body

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

    if (!school) {
        throw new CustomError.UnauthenticatedError('Invalid School ID')
    }

    if (school.status === 'SUSPENDED') {
        throw new CustomError.UnauthenticatedError('This school account has been suspended. Please contact platform support.')
    }

    let user = null;

    if (role === 'ADMIN') {
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

    const tokenUser = createTokenUser(user)
    attachCookiesToResponse({ res, user: tokenUser })

    const userContextData = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        schoolId: user.schoolId || null,
        school: school,
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

module.exports = {
    register,
    login,
    logout,
    registerAdmin
}
