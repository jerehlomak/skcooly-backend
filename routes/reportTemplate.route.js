const express = require('express');
const router = express.Router();
const {
    getTemplates,
    getTemplateById,
    getTemplateForClass,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    assignTemplateToClasses,
    getDefaultConfig
} = require('../controllers/reportTemplate.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

router.route('/')
    .get(authenticateUser, getTemplates)
    .post(authenticateUser, authorizePermissions('ADMIN'), createTemplate);

router.get('/default-config', authenticateUser, getDefaultConfig);
router.get('/class/:classId', authenticateUser, getTemplateForClass);

router.route('/:id')
    .get(authenticateUser, getTemplateById)
    .put(authenticateUser, authorizePermissions('ADMIN'), updateTemplate)
    .delete(authenticateUser, authorizePermissions('ADMIN'), deleteTemplate);

router.post('/:id/assign', authenticateUser, authorizePermissions('ADMIN'), assignTemplateToClasses);

module.exports = router;
