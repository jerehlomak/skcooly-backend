const express = require('express');
const router = express.Router();
const { authorizePermissions } = require('../middleware/authentication');

const { generateKeyForUser } = require('../controllers/recovery.controller');

// Generate recovery key for a user (Admin only)
router.post('/generate/:userId', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), generateKeyForUser);

module.exports = router;
