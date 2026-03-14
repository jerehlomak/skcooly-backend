const express = require('express')
const router = express.Router()

const billingRouter = require('./billing.route')

const {
    login, getMe, logout, setupFirstAdmin,
    getOverview,
    getSchools, getSchool, createSchool, updateSchool, suspendSchool, activateSchool, deleteSchool,
    getPlans, createPlan, updatePlan, deletePlan,
    getAnalytics,
    getFeatureFlags, upsertFeatureFlag, bulkUpsertFeatureFlags,
    getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
    getTickets, getTicket, replyToTicket, createTicket,
    getAuditLogs, getSchoolCredentials, resetSchoolCredentials, syncSchoolCounts,
    getGroups, createGroup
} = require('../controllers/central.controller')

const { authenticateCentralAdmin, requireSuperAdmin } = require('../middleware/centralAuth')

// ─── Auth (public) ─────────────────────────────────────────────────────────
router.post('/auth/login', login)
router.post('/auth/setup', setupFirstAdmin)

// ─── Protected ─────────────────────────────────────────────────────────────
router.use(authenticateCentralAdmin)

router.get('/auth/me', getMe)
router.post('/auth/logout', logout)

// ─── Overview ──────────────────────────────────────────────────────────────
router.get('/overview', getOverview)

// ─── Groups ───────────────────────────────────────────────────────────────
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

// ─── Subscription Plans ────────────────────────────────────────────────────
router.route('/plans').get(getPlans).post(requireSuperAdmin, createPlan)
router.route('/plans/:id').put(requireSuperAdmin, updatePlan).delete(requireSuperAdmin, deletePlan)

// ─── Analytics ─────────────────────────────────────────────────────────────
router.get('/analytics', getAnalytics)

// ─── Feature Flags ─────────────────────────────────────────────────────────
router.get('/features/:schoolId', getFeatureFlags)
router.post('/features/:schoolId', upsertFeatureFlag)
router.put('/features/:schoolId/bulk', bulkUpsertFeatureFlags)

// ─── Announcements ─────────────────────────────────────────────────────────
router.route('/announcements').get(getAnnouncements).post(createAnnouncement)
router.route('/announcements/:id').put(updateAnnouncement).delete(deleteAnnouncement)

// ─── Support Tickets ───────────────────────────────────────────────────────
router.route('/tickets').get(getTickets).post(createTicket)
router.get('/tickets/:id', getTicket)
router.post('/tickets/:id/reply', replyToTicket)

// ─── Audit Logs ────────────────────────────────────────────────────────────
router.get('/audit-logs', getAuditLogs)

// ─── Billing ───────────────────────────────────────────────────────────────
router.use('/billing', billingRouter)

module.exports = router
