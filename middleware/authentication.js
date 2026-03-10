const CustomError = require('../errors')
const { isTokenValid } = require('../utils')
const prisma = require('../db/prisma')

const authenticateUser = async (req, res, next) => {
    const token = req.signedCookies.token

    if (!token) {
        throw new CustomError.UnauthenticatedError('Authentication Invalid')
    }
    try {
        const payload = isTokenValid({ token })

        if (payload.schoolId) {
            const school = await prisma.school.findUnique({
                where: { id: payload.schoolId },
                select: { status: true }
            })
            if (school && school.status === 'SUSPENDED') {
                res.cookie('token', '', {
                    httpOnly: true,
                    expires: new Date(Date.now())
                })
                throw new CustomError.UnauthenticatedError('Your school account has been suspended. Please contact platform support.')
            }
        }

        req.user = {
            name: payload.name,
            userId: payload.userId,
            role: payload.role,
            schoolId: payload.schoolId || null,
            groupId: payload.groupId || null
        }
        next()
    } catch (error) {
        if (error instanceof CustomError.UnauthenticatedError) {
            throw error;
        }
        throw new CustomError.UnauthenticatedError('Authentication Invalid')
    }

}

const authorizePermissions = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            throw new CustomError.UnauthorizedError('Unathorized to access this route')
        }
        next()
    }

}

module.exports = {
    authenticateUser,
    authorizePermissions
}