const express = require('express')
const router = express.Router()

const {
    getWallet,
    fundMyWallet,
    topUpWallet,
    getSchoolWalletAdmin,
    payInvoiceFromWallet,
    setWalletStatus,
} = require('../controllers/wallet.controller')

const { authenticateUser, authorizePermissions } = require('../middleware/authentication')
const { authenticateCentralAdmin } = require('../middleware/centralAuth')

// ─── School-facing routes (authenticated school users) ────────────────────────
router.get('/my', authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), getWallet)
router.post('/fund', authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), fundMyWallet)
router.post('/pay-invoice/:invoiceId', authenticateUser, authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'), payInvoiceFromWallet)

// ─── Central admin routes ──────────────────────────────────────────────────────
router.get('/school/:schoolId', authenticateCentralAdmin, getSchoolWalletAdmin)
router.post('/school/:schoolId/topup', authenticateCentralAdmin, topUpWallet)
router.patch('/school/:schoolId/status', authenticateCentralAdmin, setWalletStatus)

module.exports = router
