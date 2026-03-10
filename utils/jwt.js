// utils/createTokenUser.js — not a separate file, inline in jwt.js
const jwt = require('jsonwebtoken')

// create token
const createJWT = ({ payload }) => {
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_LIFETIME
    })
    return token
}
// verify token
const isTokenValid = ({ token }) => jwt.verify(token, process.env.JWT_SECRET)

// attach cookies
const attachCookiesToResponse = ({ res, user }) => {
    const token = createJWT({ payload: user })

    const oneDay = 1000 * 60 * 60 * 24
    res.cookie('token', token, {
        httpOnly: true,
        expires: new Date(Date.now() + oneDay),
        secure: process.env.NODE_ENV === 'production',
        signed: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    })
}

// Build jwt payload from user object — includes schoolId for multi-tenancy
const createTokenUser = (user) => ({
    name: user.name,
    userId: user.id,
    role: user.role,
    schoolId: user.schoolId || null,
})

module.exports = {
    createJWT,
    isTokenValid,
    attachCookiesToResponse,
    createTokenUser,
}
