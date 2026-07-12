const express = require('express');
const router = express.Router();

const {
    getAllRoles,
    createRole,
    updateRole,
    deleteRole,
    getPermissions
} = require('../controllers/role.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.use(authenticateUser);
router.use(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'));

router.route('/').get(getAllRoles).post(createRole);
router.route('/permissions').get(getPermissions);
router.route('/:id').put(updateRole).delete(deleteRole);

module.exports = router;
