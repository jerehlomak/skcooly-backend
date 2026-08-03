const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    getSellableCatalog,
    searchStudentsForPos,
    processPosSale,
    getPosSales,
    getPosSaleById,
    voidPosSale,
    getDailyCashierSummary
} = require('../controllers/pos.controller');

router.use(authenticateUser);

router.get('/catalog', getSellableCatalog);
router.get('/students/search', searchStudentsForPos);
router.post('/checkout', processPosSale);
router.get('/sales', getPosSales);
router.get('/sales/daily-summary', getDailyCashierSummary);
router.get('/sales/:id', getPosSaleById);
router.post('/sales/:id/void', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), voidPosSale);

module.exports = router;
