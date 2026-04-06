const { StatusCodes } = require('http-status-codes')
const prisma = require('../db/prisma')
const argon2 = require('argon2')

// ─── COMPANY STAFF MANAGEMENT API ──────────────────────────────────────

const getStaffMembers = async (req, res) => {
    const staff = await prisma.centralAdmin.findMany({
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,
            lastLogin: true,
            createdAt: true
        },
        orderBy: { createdAt: 'desc' }
    })
    res.status(StatusCodes.OK).json({ staff })
}

const addStaffMember = async (req, res) => {
    const { name, email, password, role } = req.body

    if (!name || !email || !password) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Name, email, and password required.' })
    }

    const exists = await prisma.centralAdmin.findUnique({ where: { email } })
    if (exists) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'User already exists.' })
    }

    const hashed = await argon2.hash(password)
    
    const staff = await prisma.centralAdmin.create({
        data: {
            name,
            email,
            password: hashed,
            role: role || 'STAFF', // SUPER_ADMIN, ADMIN, STAFF
            isActive: true
        },
        select: { id: true, name: true, email: true, role: true }
    })

    res.status(StatusCodes.CREATED).json({ staff, message: 'Staff member added.' })
}

const updateStaffMember = async (req, res) => {
    const { id } = req.params
    const { name, email, password, role, isActive } = req.body

    const data = {}
    if (name) data.name = name
    if (email) data.email = email
    if (role) data.role = role
    if (isActive !== undefined) data.isActive = isActive

    if (password) {
        data.password = await argon2.hash(password)
    }

    const staff = await prisma.centralAdmin.update({
        where: { id },
        data,
        select: { id: true, name: true, email: true, role: true, isActive: true }
    })

    res.status(StatusCodes.OK).json({ staff, message: 'Staff member updated.' })
}

const deleteStaffMember = async (req, res) => {
    const { id } = req.params
    
    // Prevent self deletion
    if (id === req.centralAdmin.id) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Cannot delete yourself.' })
    }

    await prisma.centralAdmin.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ message: 'Staff member removed.' })
}

module.exports = {
    getStaffMembers,
    addStaffMember,
    updateStaffMember,
    deleteStaffMember
}
