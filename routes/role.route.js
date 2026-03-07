const express = require('express');
const router = express.Router();

const {
    getAllRoles,
    createRole,
    updateRole,
    deleteRole,
    seedDefaultRoles
} = require('../controllers/role.controller');

router.route('/').get(getAllRoles).post(createRole);
router.route('/seed').post(seedDefaultRoles);
router.route('/:id').put(updateRole).delete(deleteRole);

module.exports = router;
