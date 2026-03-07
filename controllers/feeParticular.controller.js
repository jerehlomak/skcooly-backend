
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')

const DEFAULTS = [
    { label: 'Tuition Fee (Monthly)', amount: 0, isRequired: true, isFixed: true },
    { label: 'Admission Fee (One-time)', amount: 15000, isRequired: true, isFixed: false },
    { label: 'PTA Levy', amount: 2000, isRequired: true, isFixed: false },
    { label: 'School Bus / Transport', amount: 25000, isRequired: false, isFixed: false },
    { label: 'Hostel Accommodation', amount: 50000, isRequired: false, isFixed: false },
]

// GET all fees (with auto-seed on empty)
const getFeeParticulars = async (req, res) => {
    let fees = await prisma.feeParticular.findMany({ orderBy: { createdAt: 'asc' } })

    if (fees.length === 0) {
        // Seed defaults
        await prisma.feeParticular.createMany({ data: DEFAULTS })
        fees = await prisma.feeParticular.findMany({ orderBy: { createdAt: 'asc' } })
    }

    res.status(StatusCodes.OK).json({ fees, count: fees.length })
}

// POST bulk upload (sync arrays from frontend)
const syncFeeParticulars = async (req, res) => {
    const { fees } = req.body // expected: array of fee objects

    if (!Array.isArray(fees)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Expected an array of fees' })
    }

    // Wrap in a transaction: delete old (except fixed if needed, but we can just wipe all and insert new since IDs don't matter much for global templates until assigned to students)
    await prisma.$transaction(async (tx) => {
        await tx.feeParticular.deleteMany()

        if (fees.length > 0) {
            const dataToInsert = fees.map(f => ({
                label: f.label || 'Unnamed Fee',
                amount: parseFloat(f.amount) || 0,
                isRequired: Boolean(f.isRequired),
                isFixed: Boolean(f.isFixed)
            }))
            await tx.feeParticular.createMany({ data: dataToInsert })
        }
    })

    const updatedFees = await prisma.feeParticular.findMany({ orderBy: { createdAt: 'asc' } })
    res.status(StatusCodes.OK).json({ msg: 'Fees synced successfully', fees: updatedFees })
}

module.exports = { getFeeParticulars, syncFeeParticulars }
