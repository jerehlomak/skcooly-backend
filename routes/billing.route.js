const express = require('express')
const router = express.Router()

const {
    getPlans, createPlan, updatePlan, deletePlan,
    getSubscriptions, cancelSubscription, updateSubscription,
    getInvoices, markInvoicePaid,
    getPayments,
    getCoupons, createCoupon, deleteCoupon,
    getBillingAnalytics
} = require('../controllers/billing.controller')

const { authenticateCentralAdmin, requireSuperAdmin } = require('../middleware/centralAuth')

router.use(authenticateCentralAdmin)

// Plans
router.route('/plans').get(getPlans).post(requireSuperAdmin, createPlan)
router.route('/plans/:id').put(requireSuperAdmin, updatePlan).delete(requireSuperAdmin, deletePlan)

// Subscriptions
router.route('/subscriptions').get(getSubscriptions)
router.patch('/subscriptions/:id/cancel', requireSuperAdmin, cancelSubscription)
router.put('/subscriptions/:id', requireSuperAdmin, updateSubscription)

// Invoices
router.route('/invoices').get(getInvoices)
router.post('/invoices/:id/pay', requireSuperAdmin, markInvoicePaid)

// Payments
router.route('/payments').get(getPayments)

// Coupons
router.route('/coupons').get(getCoupons).post(requireSuperAdmin, createCoupon)
router.delete('/coupons/:id', requireSuperAdmin, deleteCoupon)

// Analytics
router.get('/analytics', getBillingAnalytics)

module.exports = router
