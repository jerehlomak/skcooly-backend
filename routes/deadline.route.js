const express = require('express');
const router = express.Router();
const {
    getAllDeadlines,
    getActiveDeadlines,
    upsertDeadline,
    deleteDeadline,
    checkActivityLock
} = require('../controllers/deadline.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];

router.use(authenticateUser);

// Available to all authenticated users (dashboard warnings)
router.get('/active', getActiveDeadlines);
router.get('/check', checkActivityLock);

// Admin-only management
router.get('/', authorizePermissions(...ADMIN_ROLES), getAllDeadlines);
router.post('/', authorizePermissions(...ADMIN_ROLES), upsertDeadline);
router.delete('/:id', authorizePermissions(...ADMIN_ROLES), deleteDeadline);

module.exports = router;
