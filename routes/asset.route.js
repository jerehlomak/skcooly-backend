const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    getAssets,
    getAssetById,
    createAsset,
    updateAsset,
    deleteAsset,
    recordAssetAudit,
    getAssetAuditHistory,
    getAssetValuationSummary
} = require('../controllers/asset.controller');

router.use(authenticateUser);

router.route('/')
    .get(getAssets)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createAsset);

router.get('/valuation/summary', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getAssetValuationSummary);
router.get('/audits/history', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getAssetAuditHistory);

router.route('/:id')
    .get(getAssetById)
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateAsset)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteAsset);

router.post('/:id/audit', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), recordAssetAudit);

module.exports = router;
