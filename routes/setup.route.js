/**
 * POST /api/v1/setup/admin
 *
 * One-time endpoint to create (or force-reset) the Central Admin account.
 * Protected by ADMIN_SETUP_SECRET — never expose without this guard.
 *
 * Body (JSON):
 *   {
 *     "secret":   "<value of ADMIN_SETUP_SECRET in your .env>",
 *     "name":     "Platform Admin",       // optional, default shown
 *     "email":    "admin@skooly.com",     // optional, default shown
 *     "password": "Admin@1234",           // optional, default shown
 *     "role":     "SUPER_ADMIN",          // optional
 *     "force":    false                   // true = reset password if admin already exists
 *   }
 */

'use strict'

const express  = require('express')
const argon2   = require('argon2')
const prisma   = require('../db/prisma')

const router = express.Router()

router.post('/admin', async (req, res) => {
    const SETUP_SECRET = process.env.ADMIN_SETUP_SECRET

    if (!SETUP_SECRET) {
        return res.status(503).json({
            success: false,
            message: 'ADMIN_SETUP_SECRET is not configured on this server.',
        })
    }

    const {
        secret,
        name     = 'Platform Admin',
        email    = 'admin@skooly.com',
        password = 'Admin@1234',
        role     = 'SUPER_ADMIN',
        force    = false,
    } = req.body

    // ── Validate secret ────────────────────────────────────────────────────────
    if (!secret || secret !== SETUP_SECRET) {
        return res.status(403).json({
            success: false,
            message: 'Invalid or missing setup secret.',
        })
    }

    // ── Check for existing admin ───────────────────────────────────────────────
    const existing = await prisma.centralAdmin.findUnique({ where: { email } })

    if (existing && !force) {
        return res.status(200).json({
            success: true,
            message: `Admin already exists (${email}). Send force: true to reset password.`,
            admin: { id: existing.id, name: existing.name, email: existing.email, role: existing.role },
        })
    }

    const hashed = await argon2.hash(password)

    if (existing && force) {
        // Reset password / name / role
        const updated = await prisma.centralAdmin.update({
            where: { email },
            data:  { password: hashed, name, role, isActive: true },
            select: { id: true, name: true, email: true, role: true },
        })
        return res.status(200).json({
            success: true,
            message: `Password reset for ${email}.`,
            admin: updated,
        })
    }

    // Create fresh
    const admin = await prisma.centralAdmin.create({
        data: { name, email, password: hashed, role, isActive: true },
        select: { id: true, name: true, email: true, role: true },
    })

    return res.status(201).json({
        success: true,
        message: 'Central Admin created successfully.',
        admin,
    })
})

module.exports = router
