const express = require('express');
const router = express.Router();
const {
    createSession,
    getAllSessions,
    updateSession,
    deleteSession
, setCurrentSession} = require('../controllers/session.controller');

const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.route('/')
    .post(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createSession)
    .get(authenticateUser, getAllSessions);

router.post('/:id/current', authorizePermissions('ADMIN', 'SCHOOL_ADMIN', 'SCHOOL_SUPER_ADMIN'), setCurrentSession);
router.route('/:id')
    .patch(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateSession)
    .delete(authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteSession);

module.exports = router;
