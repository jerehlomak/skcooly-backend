const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const prisma = require('../db/prisma')

const {
    getConversations,
    getMessages,
    startConversation,
    sendMessage,
    markAsRead,
    toggleConversation
} = require('../controllers/schoolMessaging.controller')

const { authenticateCentralAdmin } = require('../middleware/centralAuth')

// ─── Safe Dual-Auth Middleware ────────────────────────────────────────────────
// Tries to identify the caller as either a Central Admin or a School User.
// Note: We check Central Admin Bearer token FIRST because in local dev
// the browser might ambiently send a school token cookie along with the request.
const dualAuth = async (req, res, next) => {
    // 1. Try central admin Bearer token (Authorization header)
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const adminToken = authHeader.split(' ')[1]
        try {
            const decoded = jwt.verify(adminToken, process.env.CENTRAL_JWT_SECRET || process.env.JWT_SECRET)
            if (decoded.type === 'central_admin') {
                const admin = await prisma.centralAdmin.findUnique({
                    where: { id: decoded.id },
                    select: { id: true, name: true, email: true, role: true, isActive: true }
                })
                if (admin && admin.isActive) {
                    req.centralAdmin = admin
                    return next()
                }
            }
        } catch { /* fall through */ }
    }

    // 2. Try central admin signed cookie (fallback)
    const adminCookieToken = req.signedCookies?.centralAdminToken
    if (adminCookieToken) {
        try {
            const decoded = jwt.verify(adminCookieToken, process.env.CENTRAL_JWT_SECRET || process.env.JWT_SECRET)
            if (decoded.type === 'central_admin') {
                const admin = await prisma.centralAdmin.findUnique({
                    where: { id: decoded.id },
                    select: { id: true, name: true, email: true, role: true, isActive: true }
                })
                if (admin && admin.isActive) {
                    req.centralAdmin = admin
                    return next()
                }
            }
        } catch { /* fall through */ }
    }

    // 3. Try school user cookie
    const schoolToken = req.signedCookies?.token
    if (schoolToken) {
        try {
            const payload = jwt.verify(schoolToken, process.env.JWT_SECRET)
            req.user = {
                id: payload.userId,       // controller reads req.user.id
                userId: payload.userId,
                name: payload.name || 'School User',
                role: payload.role,
                schoolId: payload.schoolId || null,
            }
            return next()
        } catch { /* fall through */ }
    }

    return res.status(401).json({ message: 'Authentication required. Please log in.' })
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.route('/').get(dualAuth, getConversations).post(dualAuth, startConversation)
router.route('/:id').get(dualAuth, getMessages)
router.post('/:id/reply', dualAuth, sendMessage)
router.put('/:id/read', dualAuth, markAsRead)
router.put('/:id/toggle', authenticateCentralAdmin, toggleConversation)

module.exports = router
