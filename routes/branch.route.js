const express = require('express')
const router = express.Router()

const {
    getBranches,
    getBranch,
    createBranch,
    updateBranch,
    setBranchStatus,
    deleteBranch,
    getBranchUsers,
} = require('../controllers/branch.controller')

const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

// All branch routes require authentication
router.use(authenticateUser)

// GET /api/v1/branches?schoolId=...  — list branches (scoped per role in controller)
router.get('/', getBranches)

// GET /api/v1/branches/:id  — single branch detail
router.get('/:id', getBranch)

// POST /api/v1/branches  — create a new branch (admin-level and above only)
router.post(
    '/',
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'),
    createBranch
)

// PATCH /api/v1/branches/:id  — edit branch details
router.patch(
    '/:id',
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'),
    updateBranch
)

// PATCH /api/v1/branches/:id/status  — activate / suspend / deactivate
router.patch(
    '/:id/status',
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN'),
    setBranchStatus
)

// DELETE /api/v1/branches/:id  — hard delete (only when no users assigned)
router.delete(
    '/:id',
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN'),
    deleteBranch
)

// GET /api/v1/branches/:id/users  — list users in a branch
router.get(
    '/:id/users',
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN', 'BRANCH_ADMIN'),
    getBranchUsers
)

module.exports = router
