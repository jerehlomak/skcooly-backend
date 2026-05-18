const express = require('express');
const router = express.Router();
const {
    createCategory,
    getAllCategories,
    updateCategory,
    deleteCategory
} = require('../controllers/subjectCategory.controller');

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.route('/')
    .post(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createCategory)
    .get(authenticateUser, getAllCategories);

router.route('/:id')
    .patch(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateCategory)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteCategory);

module.exports = router;
