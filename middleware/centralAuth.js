const { StatusCodes } = require('http-status-codes')
const jwt = require('jsonwebtoken')
const prisma = require('../db/prisma')

/**
 * Middleware: verifies that the request carries a valid Central Admin JWT.
 * Attaches req.centralAdmin = { id, name, email, role } on success.
 */
const authenticateCentralAdmin = async (req, res, next) => {
    let token

    // Support both Authorization header and signed cookie
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1]
    } else if (req.signedCookies?.centralAdminToken) {
        token = req.signedCookies.centralAdminToken
    }

    if (!token) {
        return res.status(StatusCodes.UNAUTHORIZED).json({
            message: 'Authentication required. No central admin token provided.',
        })
    }

    try {
        const decoded = jwt.verify(token, process.env.CENTRAL_JWT_SECRET || process.env.JWT_SECRET)

        if (decoded.type !== 'central_admin') {
            return res.status(StatusCodes.FORBIDDEN).json({ message: 'Invalid token type.' })
        }

        // Verify admin still exists and is active
        const admin = await prisma.centralAdmin.findUnique({
            where: { id: decoded.id },
            select: { id: true, name: true, email: true, role: true, isActive: true },
        })

        if (!admin || !admin.isActive) {
            return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Central admin account not found or deactivated.' })
        }

        req.centralAdmin = admin
        next()
    } catch (error) {
        return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Invalid or expired token.' })
    }
}

/**
 * Middleware: restricts access to SUPER_ADMIN role only.
 */
const requireSuperAdmin = (req, res, next) => {
    if (req.centralAdmin?.role !== 'SUPER_ADMIN') {
        return res.status(StatusCodes.FORBIDDEN).json({
            message: 'Access denied. Super Admin role required.',
        })
    }
    next()
}

module.exports = { authenticateCentralAdmin, requireSuperAdmin }
