const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const {
    getScholarships,
    getStudentScholarships,
    createScholarship,
    updateScholarship,
    deleteScholarship,
} = require('../controllers/scholarship.controller');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];

router.use(authenticateUser);

// All scholarships for the school (filterable by ?studentId= or ?status=)
router.route('/')
    .get(authorizePermissions(...ADMIN_ROLES), getScholarships)
    .post(authorizePermissions(...ADMIN_ROLES), createScholarship);

// Per-student scholarships
router.get('/student/:studentId', authorizePermissions(...ADMIN_ROLES), getStudentScholarships);

// Update / delete
router.route('/:id')
    .put(authorizePermissions(...ADMIN_ROLES), updateScholarship)
    .delete(authorizePermissions(...ADMIN_ROLES), deleteScholarship);

module.exports = router;
