const {
    getAllUsers,
    getSingleUser,
    showCurrentUser,
    updateUser,
    updateUserPassword,
    adminResetPassword,
    restrictUser,
    bulkRestrictUsers
} = require('../controllers/user.conttroller')
const { authenticateUser, authorizePermissions } = require('../middleware/authentication')

const express = require('express');
const router = express.Router();

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];

router.route('/').get(authenticateUser, authorizePermissions('ADMIN'), getAllUsers)

router.route('/showMe').get(authenticateUser, showCurrentUser)
router.route('/updateUser').post(authenticateUser, updateUser)
router.route('/updateUserPassword').post(authenticateUser, updateUserPassword)
router.route('/bulk-restrict').post(authenticateUser, authorizePermissions(...ADMIN_ROLES), bulkRestrictUsers)

router.route('/:id').get(authenticateUser, getSingleUser)
router.route('/:id/reset-password').post(authenticateUser, authorizePermissions(...ADMIN_ROLES), adminResetPassword)
router.route('/:id/restrict').patch(authenticateUser, authorizePermissions(...ADMIN_ROLES), restrictUser)

module.exports = router