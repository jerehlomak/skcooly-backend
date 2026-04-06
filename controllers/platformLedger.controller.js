const { StatusCodes } = require('http-status-codes')
const prisma = require('../db/prisma')

// ─── PLATFORM LEDGER API ──────────────────────────────────────────────────

const getTransactions = async (req, res) => {
    const { type, schoolId, category } = req.query
    const where = {}
    if (type) where.type = type
    if (schoolId) where.schoolId = schoolId
    if (category) where.category = category

    const transactions = await prisma.platformTransaction.findMany({
        where,
        orderBy: { date: 'desc' },
        include: {
            school: { select: { name: true } },
            admin: { select: { name: true } }
        }
    })

    const agg = await prisma.platformTransaction.groupBy({
        by: ['type'],
        _sum: { amount: true },
        where
    })

    const totals = { INCOME: 0, EXPENSE: 0 }
    agg.forEach(a => totals[a.type] = a._sum.amount || 0)

    res.status(StatusCodes.OK).json({ 
        transactions, 
        totals,
        net: totals.INCOME - totals.EXPENSE
    })
}

const addTransaction = async (req, res) => {
    const { type, category, amount, description, date, schoolId, reference } = req.body
    const adminId = req.centralAdmin.id

    if (!type || !category || !amount) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Type, category, and amount required.' })
    }

    const txRef = reference || `PTX-${Date.now()}`

    const transaction = await prisma.platformTransaction.create({
        data: {
            reference: txRef,
            type,
            category,
            amount: parseFloat(amount),
            description,
            date: date ? new Date(date) : new Date(),
            schoolId: schoolId || null,
            adminId
        }
    })

    res.status(StatusCodes.CREATED).json({ transaction, message: 'Transaction recorded.' })
}

const deleteTransaction = async (req, res) => {
    const { id } = req.params
    await prisma.platformTransaction.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ message: 'Transaction deleted.' })
}

module.exports = {
    getTransactions,
    addTransaction,
    deleteTransaction
}
