const express = require('express');
const router = express.Router();

const {
    getAllTerms,
    createTerm,
    updateTerm,
    deleteTerm
} = require('../controllers/term.controller');

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.use(authenticateUser);

router.route('/')
    .get(getAllTerms)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createTerm);

router.route('/:id')
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateTerm)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteTerm);

module.exports = router;
