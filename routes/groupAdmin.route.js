const express = require('express');
const router = express.Router();
const {
    login,
    logout,
    getOverview,
    getBranches,
    createSchoolAdmin,
    resetSchoolAdminPassword,
} = require('../controllers/groupAdmin.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.post('/login', login);
router.get('/logout', logout);

// Protected routes
router.use(authenticateUser);
router.use(authorizePermissions('GROUP_ADMIN'));

router.get('/overview', getOverview);
router.get('/branches', getBranches);
router.post('/schools/:schoolId/admins', createSchoolAdmin);
router.post('/admins/:adminId/reset-password', resetSchoolAdminPassword);

module.exports = router;
