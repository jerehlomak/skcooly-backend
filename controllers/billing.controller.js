const { StatusCodes } = require('http-status-codes')
const prisma = require('../db/prisma')

// ─── PLANS ───────────────────────────────────────────────────────────────────
const getPlans = async (req, res) => {
    const plans = await prisma.subscriptionPlan.findMany({ orderBy: { monthlyPrice: 'asc' } })
    res.status(StatusCodes.OK).json({ plans, count: plans.length })
}

const createPlan = async (req, res) => {
    const plan = await prisma.subscriptionPlan.create({ data: req.body })
    res.status(StatusCodes.CREATED).json({ plan })
}

const updatePlan = async (req, res) => {
    const { id } = req.params
    const plan = await prisma.subscriptionPlan.update({ where: { id }, data: req.body })
    res.status(StatusCodes.OK).json({ plan })
}

const deletePlan = async (req, res) => {
    const { id } = req.params
    await prisma.subscriptionPlan.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ msg: 'Plan deleted' })
}

// ─── SUBSCRIPTIONS ───────────────────────────────────────────────────────────
const getSubscriptions = async (req, res) => {
    const subscriptions = await prisma.schoolSubscription.findMany({
        include: { school: { select: { name: true, email: true } }, plan: { select: { name: true } } }
    })
    res.status(StatusCodes.OK).json({ subscriptions, count: subscriptions.length })
}

const cancelSubscription = async (req, res) => {
    const { id } = req.params
    const subscription = await prisma.schoolSubscription.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), isActive: false }
    })
    res.status(StatusCodes.OK).json({ subscription, msg: 'Subscription cancelled' })
}

const updateSubscription = async (req, res) => {
    const { id } = req.params
    const subscription = await prisma.schoolSubscription.update({
        where: { id },
        data: req.body
    })
    res.status(StatusCodes.OK).json({ subscription })
}

// ─── INVOICES ────────────────────────────────────────────────────────────────
const getInvoices = async (req, res) => {
    const invoices = await prisma.invoice.findMany({
        include: { school: { select: { name: true } }, items: true }
    })
    res.status(StatusCodes.OK).json({ invoices, count: invoices.length })
}

const markInvoicePaid = async (req, res) => {
    const { id } = req.params
    const invoice = await prisma.invoice.update({
        where: { id },
        data: { status: 'PAID' }
    })

    // Create a payment record
    await prisma.payment.create({
        data: {
            invoiceId: id,
            schoolId: invoice.schoolId,
            paymentMethod: 'BANK_TRANSFER', // Assume manual mark as paid is bank transfer
            amount: invoice.totalAmount,
            currency: invoice.currency,
            status: 'COMPLETED',
            paidAt: new Date()
        }
    })

    res.status(StatusCodes.OK).json({ invoice })
}

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
const getPayments = async (req, res) => {
    const payments = await prisma.payment.findMany({
        include: { school: { select: { name: true } }, invoice: { select: { invoiceNumber: true } } }
    })
    res.status(StatusCodes.OK).json({ payments, count: payments.length })
}


// ─── COUPONS ─────────────────────────────────────────────────────────────────
const getCoupons = async (req, res) => {
    const coupons = await prisma.coupon.findMany()
    res.status(StatusCodes.OK).json({ coupons, count: coupons.length })
}

const createCoupon = async (req, res) => {
    const coupon = await prisma.coupon.create({ data: req.body })
    res.status(StatusCodes.CREATED).json({ coupon })
}

const deleteCoupon = async (req, res) => {
    const { id } = req.params
    await prisma.coupon.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ msg: 'Coupon deleted' })
}

// ─── ANALYTICS ───────────────────────────────────────────────────────────────
const getBillingAnalytics = async (req, res) => {
    const subscriptions = await prisma.schoolSubscription.findMany({
        include: { plan: true }
    })

    let mrr = 0
    let arr = 0
    let activeSubscriptions = 0
    let pastDueAccounts = 0

    subscriptions.forEach(sub => {
        if (sub.status === 'ACTIVE' && sub.plan) {
            activeSubscriptions++
            if (sub.billingCycle === 'MONTHLY') {
                mrr += sub.plan.monthlyPrice || 0
                arr += (sub.plan.monthlyPrice || 0) * 12
            } else {
                arr += sub.plan.yearlyPrice || 0
                mrr += (sub.plan.yearlyPrice || 0) / 12
            }
        } else if (sub.status === 'PAST_DUE') {
            pastDueAccounts++
        }
    })

    const totalSchools = await prisma.school.count()

    res.status(StatusCodes.OK).json({
        mrr, arr, activeSubscriptions, pastDueAccounts, totalSchools
    })
}

module.exports = {
    getPlans, createPlan, updatePlan, deletePlan,
    getSubscriptions, cancelSubscription, updateSubscription,
    getInvoices, markInvoicePaid,
    getPayments,
    getCoupons, createCoupon, deleteCoupon,
    getBillingAnalytics
}
