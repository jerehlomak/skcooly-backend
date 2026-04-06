const { StatusCodes } = require('http-status-codes')
const prisma = require('../db/prisma')
const { generateUniquePins } = require('../utils/pinCodeGenerator')

// ─── PIN MANAGEMENT API ──────────────────────────────────────────────────

const generatePins = async (req, res) => {
    const { quantity, pricePerPin, schoolId, pinType } = req.body
    const adminId = req.centralAdmin.id

    if (!quantity || quantity < 1) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Valid quantity required.' })
    }

    // Generate Batch Number
    const count = await prisma.schoolPinBatch.count()
    const batchNumber = `BTN-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    // Start a transaction since we insert many pins
    const batch = await prisma.$transaction(async (tx) => {
        const newBatch = await tx.schoolPinBatch.create({
            data: {
                batchNumber,
                pinType: pinType || 'RESULT_CHECKING',
                quantity,
                pricePerPin: pricePerPin || 0,
                schoolId: schoolId || null,
                adminId
            }
        })

        const uniquePinCodes = await generateUniquePins(tx, quantity, 10)

        const pinsData = uniquePinCodes.map((pinCode, index) => {
            return {
                batchId: newBatch.id,
                pinCode,
                serialNumber: `${batchNumber}-${String(index + 1).padStart(5, '0')}`,
                pinType: pinType || 'RESULT_CHECKING',
                schoolId: schoolId || null,
                maxUsage: 5 // Default
            }
        })

        await tx.schoolPin.createMany({
            data: pinsData
        })

        return newBatch
    })

    res.status(StatusCodes.CREATED).json({ batch, message: `Successfully generated ${quantity} PINs.` })
}

const getPinBatches = async (req, res) => {
    const batches = await prisma.schoolPinBatch.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
            school: { select: { name: true } },
            admin: { select: { name: true } },
            _count: {
                select: { pins: true }
            }
        }
    })

    // Compute stats manually or fetch via group
    const stats = await prisma.schoolPinBatch.aggregate({
        _sum: { quantity: true }
    })

    res.status(StatusCodes.OK).json({ batches, totalPins: stats._sum.quantity || 0 })
}

const assignBatch = async (req, res) => {
    const { batchId } = req.params
    const { schoolId } = req.body

    const batch = await prisma.$transaction(async (tx) => {
        const updatedBatch = await tx.schoolPinBatch.update({
            where: { id: batchId },
            data: { schoolId }
        })

        // cascade assign to all pins
        await tx.schoolPin.updateMany({
            where: { batchId },
            data: { schoolId }
        })

        return updatedBatch
    })

    res.status(StatusCodes.OK).json({ batch })
}

const getPins = async (req, res) => {
    const { batchId, schoolId, status } = req.query
    const where = {}
    if (batchId) where.batchId = batchId
    if (schoolId) where.schoolId = schoolId
    if (status) where.status = status

    const pins = await prisma.schoolPin.findMany({
        where,
        take: 200, // Limit to 200 for view
        orderBy: { createdAt: 'desc' },
        include: { school: { select: { name: true } } }
    })

    console.log("pins", pins);

    res.status(StatusCodes.OK).json({ pins })
}

module.exports = {
    generatePins,
    getPinBatches,
    getPins,
    assignBatch
}
