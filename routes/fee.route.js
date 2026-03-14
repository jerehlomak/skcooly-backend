const express = require('express');
const router = express.Router();
const { assignFees, getStudentLedger } = require('../controllers/fee.controller');
const { authenticateUser, authorizePermissions } = require('../middleware/authentication');

// Assign Fees (Admins only)
router.post('/assign', authenticateUser, authorizePermissions('ADMIN'), assignFees);

// View Ledger (Admins, or the specific Student/Parent)
// We will let the controller handle row-level security so anyone auth'd can hit the route but only see what they own
router.get('/ledger/:studentId', authenticateUser, getStudentLedger);

module.exports = router;
