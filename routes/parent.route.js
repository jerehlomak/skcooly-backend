const express = require('express');
const router = express.Router();
const { addParent, getAllParents, getParent, updateParent, deleteParent } = require('../controllers/parent.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.route('/all').get(authenticateUser, authorizePermissions('ADMIN'), getAllParents)
router.route('/add').post(authenticateUser, authorizePermissions('ADMIN'), addParent)
router.route('/:id')
    .get(authenticateUser, authorizePermissions('ADMIN'), getParent)
    .patch(authenticateUser, authorizePermissions('ADMIN'), updateParent)
    .delete(authenticateUser, authorizePermissions('ADMIN'), deleteParent)

module.exports = router;
