const express = require('express');
const router = express.Router();
const {
    createSection,
    getAllSections,
    updateSection,
    deleteSection
} = require('../controllers/section.controller');

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.route('/')
    .post(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createSection)
    .get(authenticateUser, getAllSections);

router.route('/:id')
    .patch(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateSection)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteSection);

module.exports = router;
