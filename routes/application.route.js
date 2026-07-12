const express = require('express');
const router = express.Router();
const { validateApplicationPin, submitApplication, adminSubmitApplication, getSchoolApplications, updateApplicationStatus, getAllApplications, initParentApplication, parentSubmitApplication } = require('../controllers/application.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Public
router.post('/validate-pin', validateApplicationPin);
router.post('/submit', submitApplication);

// Protected (School Admin / Super Admin)
router.use(authenticateUser);

// Parent Portal
router.get('/parent/init', authorizePermissions('PARENT'), initParentApplication);
router.post('/parent/submit', authorizePermissions('PARENT'), parentSubmitApplication);

// Central Admin only
router.get('/all', authorizePermissions('ADMIN'), getAllApplications);

router.use(authorizePermissions('SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN', 'ADMIN'));
router.post('/admin/submit', adminSubmitApplication);
router.get('/school', getSchoolApplications);
router.put('/school/:id/status', updateApplicationStatus);

module.exports = router;
