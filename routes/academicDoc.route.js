const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');
const c = require('../controllers/academicDoc.controller');

// Teachers and admins both use the module; ownership rules are enforced in the controller.
const staff = [authenticateUser, authorizePermissions('ADMIN', 'TEACHER')];
const admin = [authenticateUser, authorizePermissions('ADMIN')];

// Signed, expiring link (WhatsApp / anything that can't take an attachment) — no login
router.get('/public/:token', c.publicDownload);

router.get('/meta', ...staff, c.getMeta);
router.put('/config', ...admin, c.saveConfig);
router.post('/generate', ...staff, c.generate);
router.post('/export', ...staff, c.exportDraft);
router.post('/upload', ...staff, c.uploadDoc);

router.route('/').get(...staff, c.listDocs).post(...staff, c.createDoc);
router.route('/:id').get(...staff, c.getDoc).put(...staff, c.updateDoc).delete(...staff, c.deleteDoc);
router.get('/:id/export', ...staff, c.exportSaved);
router.get('/:id/file', ...staff, c.downloadOriginal);
router.post('/:id/share/email', ...staff, c.shareEmail);
router.post('/:id/share/link', ...staff, c.createShareLink);

module.exports = router;
