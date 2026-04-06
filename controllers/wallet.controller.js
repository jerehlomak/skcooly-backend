const { StatusCodes } = require('http-status-codes')
const prisma = require('../db/prisma')
const { nanoid } = require('nanoid')

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const genRef = () => `WT-${Date.now()}-${nanoid(6).toUpperCase()}`

async function creditWallet(tx, walletId, schoolId, amount, source, sourceId, description, adminId) {
    const wallet = await tx.schoolWallet.findUnique({ where: { id: walletId } })
    if (!wallet) throw new Error('Wallet not found')
    const balanceBefore = wallet.balance
    const balanceAfter = balanceBefore + amount
    await tx.schoolWallet.update({ where: { id: walletId }, data: { balance: balanceAfter } })
    await tx.walletTransaction.create({
        data: {
            walletId, schoolId, type: 'CREDIT', source, sourceId,
            amount, balanceBefore, balanceAfter,
            reference: genRef(), description,
            createdByAdminId: adminId || null,
        }
    })
    return balanceAfter
}

async function debitWallet(tx, walletId, schoolId, amount, source, sourceId, description, userId) {
    const wallet = await tx.schoolWallet.findUnique({ where: { id: walletId } })
    if (!wallet) throw new Error('Wallet not found')
    if (wallet.status === 'FROZEN') throw new Error('Wallet is frozen')
    if (wallet.balance < amount) throw new Error('Insufficient wallet balance')
    const balanceBefore = wallet.balance
    const balanceAfter = balanceBefore - amount
    await tx.schoolWallet.update({ where: { id: walletId }, data: { balance: balanceAfter } })
    await tx.walletTransaction.create({
        data: {
            walletId, schoolId, type: 'DEBIT', source, sourceId,
            amount, balanceBefore, balanceAfter,
            reference: genRef(), description,
            createdBySchoolUserId: userId || null,
        }
    })
    return balanceAfter
}

// ─── SCHOOL: Get Own Wallet ────────────────────────────────────────────────────
const getWallet = async (req, res) => {
    const { schoolId } = req.user

    // Auto-provision wallet if it doesn't exist yet
    let wallet = await prisma.schoolWallet.findUnique({ where: { schoolId } })
    if (!wallet) {
        wallet = await prisma.schoolWallet.create({ data: { schoolId } })
    }

    const transactions = await prisma.walletTransaction.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: 50,
    })

    res.status(StatusCodes.OK).json({ wallet, transactions })
}

// ─── SCHOOL: Fund Own Wallet (Simulated Payment Gateway) ─────────────────────
const fundMyWallet = async (req, res) => {
    const { schoolId, userId } = req.user
    const { amount } = req.body

    if (!amount || amount <= 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Valid amount required' })
    }

    const result = await prisma.$transaction(async (tx) => {
        let wallet = await tx.schoolWallet.findUnique({ where: { schoolId } })
        if (!wallet) {
            wallet = await tx.schoolWallet.create({ data: { schoolId } })
        }
        
        // Simulating the payment processor credit
        const newBalance = await creditWallet(
            tx, wallet.id, schoolId, amount,
            'TOPUP', null,
            'Wallet funded via payment gateway (Simulated)',
            null
        )
        return { walletId: wallet.id, newBalance }
    })

    res.status(StatusCodes.OK).json({
        message: `Wallet funded successfully with ₦${amount.toLocaleString()}`,
        ...result
    })
}

// ─── CENTRAL ADMIN: Top Up a School Wallet ────────────────────────────────────
const topUpWallet = async (req, res) => {
    const { schoolId } = req.params
    const { amount, description } = req.body
    const adminId = req.centralAdmin?.id || null

    if (!amount || amount <= 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Valid amount required' })
    }

    const result = await prisma.$transaction(async (tx) => {
        let wallet = await tx.schoolWallet.findUnique({ where: { schoolId } })
        if (!wallet) {
            wallet = await tx.schoolWallet.create({ data: { schoolId } })
        }
        const newBalance = await creditWallet(
            tx, wallet.id, schoolId, amount,
            'TOPUP', null,
            description || 'Manual top-up by platform admin',
            adminId
        )
        return { walletId: wallet.id, newBalance }
    })

    res.status(StatusCodes.OK).json({
        message: `Wallet topped up with ₦${amount.toLocaleString()}`,
        ...result
    })
}

// ─── CENTRAL ADMIN: Get School Wallet (with history) ─────────────────────────
const getSchoolWalletAdmin = async (req, res) => {
    const { schoolId } = req.params

    let wallet = await prisma.schoolWallet.findUnique({ where: { schoolId } })
    if (!wallet) {
        wallet = await prisma.schoolWallet.create({ data: { schoolId } })
    }

    const transactions = await prisma.walletTransaction.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: 100,
    })

    res.status(StatusCodes.OK).json({ wallet, transactions })
}

// ─── SCHOOL: Pay Invoice from Wallet ─────────────────────────────────────────
const payInvoiceFromWallet = async (req, res) => {
    const { schoolId, userId } = req.user
    const { invoiceId } = req.params

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
    if (!invoice) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Invoice not found' })
    if (invoice.schoolId !== schoolId) return res.status(StatusCodes.FORBIDDEN).json({ message: 'Not your invoice' })
    if (invoice.status === 'PAID') return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invoice already paid' })

    const amountDue = invoice.amountDue ?? (invoice.totalAmount - invoice.amountPaid)
    if (amountDue <= 0) return res.status(StatusCodes.BAD_REQUEST).json({ message: 'No balance due on this invoice' })

    await prisma.$transaction(async (tx) => {
        const wallet = await tx.schoolWallet.findUnique({ where: { schoolId } })
        if (!wallet) throw new Error('Wallet not found. Please contact support.')

        await debitWallet(
            tx, wallet.id, schoolId, amountDue,
            'INVOICE_PAYMENT', invoiceId,
            `Payment for invoice #${invoice.invoiceNumber}`,
            userId
        )

        const newAmountPaid = invoice.amountPaid + amountDue
        await tx.invoice.update({
            where: { id: invoiceId },
            data: {
                amountPaid: newAmountPaid,
                amountDue: 0,
                status: 'PAID',
                paidFromWallet: true,
            }
        })
    })

    res.status(StatusCodes.OK).json({ message: 'Invoice paid successfully from wallet.' })
}

// ─── CENTRAL ADMIN: Freeze / Unfreeze Wallet ─────────────────────────────────
const setWalletStatus = async (req, res) => {
    const { schoolId } = req.params
    const { status } = req.body // ACTIVE | FROZEN

    const wallet = await prisma.schoolWallet.update({
        where: { schoolId },
        data: { status }
    })

    res.status(StatusCodes.OK).json({ wallet })
}

module.exports = {
    getWallet,
    fundMyWallet,
    topUpWallet,
    getSchoolWalletAdmin,
    payInvoiceFromWallet,
    setWalletStatus,
}
