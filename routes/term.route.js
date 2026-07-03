const express = require('express');
const router = express.Router();

const {
    getAllTerms,
    createTerm,
    updateTerm,
    deleteTerm,
    openTerm,
    toggleLock,
    updateActiveTermDaysOpened
} = require('../controllers/term.controller');

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.use(authenticateUser);

router.route('/')
    .get(getAllTerms)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createTerm);

router.route('/active/days-opened')
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateActiveTermDaysOpened);

router.route('/:id')
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateTerm)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteTerm);

router.route('/:id/open')
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), openTerm);

router.route('/:id/lock')
    .patch(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), toggleLock);

module.exports = router;
