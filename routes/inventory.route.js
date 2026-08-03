const express = require('express');
const router = express.Router();
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

const {
    getInventoryItems,
    getInventoryItemById,
    createInventoryItem,
    updateInventoryItem,
    deleteInventoryItem,
    restockInventory,
    recordStockUsage,
    getItemMovements,
    getInventoryValuationReport
} = require('../controllers/inventory.controller');

router.use(authenticateUser);

router.route('/')
    .get(getInventoryItems)
    .post(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), createInventoryItem);

router.get('/valuation/report', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getInventoryValuationReport);
router.get('/movements/history', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getItemMovements);

router.route('/:id')
    .get(getInventoryItemById)
    .put(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), updateInventoryItem)
    .delete(authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), deleteInventoryItem);

router.post('/:id/restock', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), restockInventory);
router.post('/:id/usage', authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), recordStockUsage);

module.exports = router;
