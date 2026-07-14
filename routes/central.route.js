const express = require('express')
const router = express.Router()

const billingRouter = require('./billing.route')

const {
    setupAdmin, verifySetupAdmin,
    login, verifyLogin, getMe, logout,
    forgotPassword, resetPassword,
    getOverview,
    getSchools, getSchool, createSchool, updateSchool, suspendSchool, activateSchool, deleteSchool,
    getPlans, createPlan, updatePlan, deletePlan,
    getAnalytics, getFinancialAnalytics,
    getSchoolDashboards, upsertSchoolDashboard,
    getFeatureFlags, upsertFeatureFlag, bulkUpsertFeatureFlags, getPermissionModules,
    getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
    getTickets, getTicket, replyToTicket, createTicket,
    getAuditLogs, getSchoolCredentials, resetSchoolCredentials, syncSchoolCounts,
    getGroups, createGroup,
    createInvoice, getInvoices, getInvoice, updateInvoice, deleteInvoice,
    sendInvoice, recordInvoicePayment, sendInvoiceReminder,
    createLead, getLeads, updateLeadStatus
} = require('../controllers/central.controller')

const { getSchoolWalletAdmin, topUpWallet, setWalletStatus } = require('../controllers/wallet.controller')
const { getStaffMembers, addStaffMember, updateStaffMember, deleteStaffMember } = require('../controllers/companyStaff.controller')
const { generatePins, getPinBatches, getPins, assignBatch } = require('../controllers/pin.controller')
const { getTransactions, addTransaction, deleteTransaction } = require('../controllers/platformLedger.controller')

const { authenticateCentralAdmin, requireSuperAdmin } = require('../middleware/centralAuth')

// ─── Auth (public) ─────────────────────────────────────────────────────────
router.post('/auth/setup', setupAdmin)
router.post('/auth/setup/verify', verifySetupAdmin)
router.post('/auth/login', login)
router.post('/auth/login/verify', verifyLogin)
router.post('/auth/forgot-password', forgotPassword)
router.post('/auth/reset-password', resetPassword)

// ─── Public Subscription Plans & Leads ──────────────────────────────────────
router.get('/plans', getPlans)
router.post('/leads', createLead)

// ─── Protected ─────────────────────────────────────────────────────────────
router.use(authenticateCentralAdmin)

router.get('/auth/me', getMe)
router.post('/auth/logout', logout)

// ─── Overview ──────────────────────────────────────────────────────────────
router.get('/overview', getOverview)

// ─── Groups ────────────────────────────────────────────────────────────────
router.route('/groups').get(getGroups).post(createGroup)

// ─── Schools ───────────────────────────────────────────────────────────────
router.route('/schools').get(getSchools).post(createSchool)
router.route('/schools/:id').get(getSchool).put(updateSchool)
router.post('/schools/:id/suspend', suspendSchool)
router.post('/schools/:id/activate', activateSchool)
router.delete('/schools/:id', requireSuperAdmin, deleteSchool)

// Credentials & Sync
router.get('/schools/:id/credentials', getSchoolCredentials)
router.post('/schools/:id/credentials/reset', requireSuperAdmin, resetSchoolCredentials)
router.post('/schools/:id/sync-counts', syncSchoolCounts)

// ─── Subscription Plans (Protected Mutations) ──────────────────────────────────
router.route('/plans').post(requireSuperAdmin, createPlan)
router.route('/plans/:id').put(requireSuperAdmin, updatePlan).delete(requireSuperAdmin, deletePlan)

// ─── Analytics ─────────────────────────────────────────────────────────────
router.get('/analytics', getAnalytics)
router.get('/analytics/financials', getFinancialAnalytics)

// ─── RBAC: Dashboard toggles (Layer 1) ──────────────────────────────────────
router.get('/schools/:schoolId/dashboards', getSchoolDashboards)
router.put('/schools/:schoolId/dashboards', upsertSchoolDashboard)

// ─── RBAC: Menu-item subscription (Layer 2) ─────────────────────────────────
router.get('/permissions/modules', getPermissionModules)
router.get('/features/:schoolId', getFeatureFlags)
router.post('/features/:schoolId', upsertFeatureFlag)
router.put('/features/:schoolId/bulk', bulkUpsertFeatureFlags)

// ─── Announcements ─────────────────────────────────────────────────────────
router.route('/announcements').get(getAnnouncements).post(createAnnouncement)
router.route('/announcements/:id').put(updateAnnouncement).delete(deleteAnnouncement)

// ─── Leads ─────────────────────────────────────────────────────────────────
router.get('/leads', getLeads)
router.put('/leads/:id/status', updateLeadStatus)

// ─── Support Tickets ───────────────────────────────────────────────────────
router.route('/tickets').get(getTickets).post(createTicket)
router.get('/tickets/:id', getTicket)
router.post('/tickets/:id/reply', replyToTicket)

// ─── Audit Logs ────────────────────────────────────────────────────────────
router.get('/audit-logs', getAuditLogs)

// ─── Company Staff ─────────────────────────────────────────────────────────
router.route('/staff')
    .get(requireSuperAdmin, getStaffMembers)
    .post(requireSuperAdmin, addStaffMember)
router.route('/staff/:id')
    .put(requireSuperAdmin, updateStaffMember)
    .delete(requireSuperAdmin, deleteStaffMember)

// ─── PIN Management ────────────────────────────────────────────────────────
router.route('/pins/batches').get(getPinBatches).post(generatePins)
router.post('/pins/batches/:batchId/assign', assignBatch)
router.get('/pins', getPins)

// ─── Platform Ledger ───────────────────────────────────────────────────────
router.route('/ledger').get(getTransactions).post(addTransaction)
router.delete('/ledger/:id', requireSuperAdmin, deleteTransaction)

// ─── Invoice Management (Phase 10) ────────────────────────────────────────
router.route('/invoices').get(getInvoices).post(createInvoice)
router.route('/invoices/:id').get(getInvoice).put(updateInvoice).delete(deleteInvoice)
router.post('/invoices/:id/send', sendInvoice)
router.post('/invoices/:id/payment', recordInvoicePayment)
router.post('/invoices/:id/reminder', sendInvoiceReminder)

// ─── Wallet Admin (Phase 6) ───────────────────────────────────────────────
router.get('/wallet/:schoolId', getSchoolWalletAdmin)
router.post('/wallet/:schoolId/topup', topUpWallet)
router.patch('/wallet/:schoolId/status', setWalletStatus)

// ─── Billing ───────────────────────────────────────────────────────────────
router.use('/billing', billingRouter)

module.exports = router
