const { StatusCodes } = require('http-status-codes')
const prisma = require('../db/prisma')

// ─── Branch CRUD ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/branches?schoolId=...
 * List all branches for a school.
 * Accessible by: central admin, school_super_admin, school_admin (of the same school)
 */
const getBranches = async (req, res) => {
    const { schoolId } = req.query

    if (!schoolId) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'schoolId query parameter is required.' })
    }

    // Branch-level users can only see their own branch
    if (
        req.user &&
        (req.user.role === 'BRANCH_ADMIN' || req.user.role === 'BRANCH_STAFF') &&
        req.user.branchId
    ) {
        const branch = await prisma.branch.findUnique({
            where: { id: req.user.branchId },
            include: { _count: { select: { users: true } } },
        })
        return res.status(StatusCodes.OK).json({ branches: branch ? [branch] : [] })
    }

    const branches = await prisma.branch.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'asc' },
        include: {
            _count: { select: { users: true } },
        },
    })

    res.status(StatusCodes.OK).json({ branches })
}

/**
 * GET /api/v1/branches/:id
 * Get single branch detail.
 */
const getBranch = async (req, res) => {
    const { id } = req.params

    const branch = await prisma.branch.findUnique({
        where: { id },
        include: {
            school: { select: { id: true, name: true, schoolCode: true } },
            _count: { select: { users: true } },
        },
    })

    if (!branch) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'Branch not found.' })
    }

    // Branch users can only see their own branch
    if (
        req.user &&
        (req.user.role === 'BRANCH_ADMIN' || req.user.role === 'BRANCH_STAFF') &&
        req.user.branchId !== id
    ) {
        return res.status(StatusCodes.FORBIDDEN).json({ message: 'Access denied.' })
    }

    res.status(StatusCodes.OK).json({ branch })
}

/**
 * POST /api/v1/branches
 * Create a new branch under a school.
 * Body: { schoolId, name, code?, address? }
 */
const createBranch = async (req, res) => {
    const { schoolId, name, code, address } = req.body

    if (!schoolId || !name) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'schoolId and name are required.' })
    }

    // Verify school exists
    const school = await prisma.school.findUnique({ 
        where: { id: schoolId },
        include: { plan: true }
    })
    if (!school) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'School not found.' })
    }

    if (school.plan && school.plan.maxBranches) {
        const currentBranchCount = await prisma.branch.count({
            where: { schoolId }
        })
        if (currentBranchCount >= school.plan.maxBranches) {
            return res.status(StatusCodes.FORBIDDEN).json({ message: `Plan limit reached: Maximum allowed branches is ${school.plan.maxBranches}. Please upgrade your plan to add more.` })
        }
    }

    try {
        const branch = await prisma.branch.create({
            data: {
                schoolId,
                name: name.trim(),
                code: code?.trim() || null,
                address: address?.trim() || null,
                status: 'ACTIVE',
            },
        })

        res.status(StatusCodes.CREATED).json({ branch, message: 'Branch created successfully.' })
    } catch (error) {
        console.error('[createBranch] error:', error)
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message || 'Failed to create branch.' })
    }
}

/**
 * PATCH /api/v1/branches/:id
 * Update branch details.
 * Body: { name?, code?, address? }
 */
const updateBranch = async (req, res) => {
    const { id } = req.params
    const { name, code, address } = req.body

    const existing = await prisma.branch.findUnique({ where: { id } })
    if (!existing) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'Branch not found.' })
    }

    try {
        const branch = await prisma.branch.update({
            where: { id },
            data: {
                name: name?.trim() ?? existing.name,
                code: code !== undefined ? code?.trim() || null : existing.code,
                address: address !== undefined ? address?.trim() || null : existing.address,
            },
        })

        res.status(StatusCodes.OK).json({ branch, message: 'Branch updated.' })
    } catch (error) {
        console.error('[updateBranch] error:', error)
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message || 'Failed to update branch.' })
    }
}

/**
 * PATCH /api/v1/branches/:id/status
 * Activate or suspend a branch.
 * Body: { status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' }
 */
const setBranchStatus = async (req, res) => {
    const { id } = req.params
    const { status } = req.body

    const validStatuses = ['ACTIVE', 'SUSPENDED', 'INACTIVE']
    if (!validStatuses.includes(status)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: `Status must be one of: ${validStatuses.join(', ')}` })
    }

    const existing = await prisma.branch.findUnique({ where: { id } })
    if (!existing) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'Branch not found.' })
    }

    const branch = await prisma.branch.update({ where: { id }, data: { status } })

    res.status(StatusCodes.OK).json({ branch, message: `Branch ${status.toLowerCase()}.` })
}

/**
 * DELETE /api/v1/branches/:id
 * Hard delete a branch (only if no users are assigned).
 */
const deleteBranch = async (req, res) => {
    const { id } = req.params

    const existing = await prisma.branch.findUnique({
        where: { id },
        include: { _count: { select: { users: true } } },
    })

    if (!existing) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'Branch not found.' })
    }

    if (existing._count.users > 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({
            message: `Cannot delete branch with ${existing._count.users} assigned user(s). Reassign or remove users first.`,
        })
    }

    await prisma.branch.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ message: 'Branch deleted.' })
}

/**
 * GET /api/v1/branches/:id/users
 * List users assigned to a specific branch.
 */
const getBranchUsers = async (req, res) => {
    const { id } = req.params

    const branch = await prisma.branch.findUnique({ where: { id } })
    if (!branch) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'Branch not found.' })
    }

    const users = await prisma.user.findMany({
        where: { branchId: id, isDeleted: false },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
        orderBy: { name: 'asc' },
    })

    res.status(StatusCodes.OK).json({ users })
}

module.exports = {
    getBranches,
    getBranch,
    createBranch,
    updateBranch,
    setBranchStatus,
    deleteBranch,
    getBranchUsers,
}
