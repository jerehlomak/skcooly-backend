const express = require('express');
const router = express.Router();
const {
    createSection,
    getSections,
    updateSection,
    deleteSection
} = require('../controllers/section.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const admin = [authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_ADMIN', 'SCHOOL_SUPER_ADMIN')];

router.route('/')
    .get(authenticateUser, getSections)
    .post(...admin, createSection);

router.route('/:id')
    .patch(...admin, updateSection)
    .delete(...admin, deleteSection);

module.exports = router;
