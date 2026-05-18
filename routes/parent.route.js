const express = require('express');
const router = express.Router();
const { addParent, getAllParents, getParent, updateParent, deleteParent, getMyChildrenAcademics, assignChildToParent } = require('../controllers/parent.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];

router.route('/all').get(authenticateUser, authorizePermissions(...ADMIN_ROLES), getAllParents);
router.route('/add').post(authenticateUser, authorizePermissions(...ADMIN_ROLES), addParent);
router.route('/my-children/academics').get(authenticateUser, authorizePermissions('PARENT'), getMyChildrenAcademics);

// Dedicated assign-child endpoint (can be called standalone or during edit)
router.post('/:id/assign-child', authenticateUser, authorizePermissions(...ADMIN_ROLES), assignChildToParent);

router.route('/:id')
    .get(authenticateUser, authorizePermissions(...ADMIN_ROLES), getParent)
    .patch(authenticateUser, authorizePermissions(...ADMIN_ROLES), updateParent)
    .delete(authenticateUser, authorizePermissions(...ADMIN_ROLES), deleteParent);

module.exports = router;

