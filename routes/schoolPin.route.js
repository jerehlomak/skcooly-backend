const express = require('express')
const router = express.Router()

const {
    getSchoolBatches,
    getSchoolPins,
    validateAndLinkPin,
    reactivatePin,
    revealPin
} = require('../controllers/schoolPin.controller')

const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

// ─── Protected Routes (Tenant-Scoped) ──────────────────────────────────────
router.use(authenticateUser)

// School Admin endpoints
router.route('/batches').get(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getSchoolBatches)
router.route('/list').get(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getSchoolPins)

// Student endpoint
router.post('/validate', authorizePermissions('STUDENT'), validateAndLinkPin)

router.patch('/:id/reactivate', authenticateUser, authorizePermissions('ADMIN'), reactivatePin)
router.get('/:id/reveal', authenticateUser, authorizePermissions('ADMIN'), revealPin)

module.exports = router
