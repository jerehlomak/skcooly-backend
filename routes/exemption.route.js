const express = require('express');
const router = express.Router();
const { getExemptions, grantExemption, revokeExemption } = require('../controllers/exemption.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.use(authenticateUser);

router.route('/')
    .get(authorizePermissions('ADMIN', 'SUPER_ADMIN'), getExemptions)
    .post(authorizePermissions('ADMIN', 'SUPER_ADMIN'), grantExemption);

router.route('/:id')
    .delete(authorizePermissions('ADMIN', 'SUPER_ADMIN'), revokeExemption);

module.exports = router;
