const { StatusCodes } = require('http-status-codes')
const prisma = require('../db/prisma')
const CustomError = require('../errors')

// ─── SCHOOL ADMIN: View Assigned Batches ──────────────────────────────────
const getSchoolBatches = async (req, res) => {
    const schoolId = req.user.schoolId
    const { pinType } = req.query

    const where = { schoolId }
    if (pinType && pinType !== 'ALL') where.pinType = pinType

    // Fetch batches assigned to this school
    const batches = await prisma.schoolPinBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
            _count: {
                select: { pins: true }
            }
        }
    })

    // Calculate usage per batch
    const batchesWithStats = await Promise.all(batches.map(async (batch) => {
        const usedCount = await prisma.schoolPin.count({
            where: { batchId: batch.id, usageCount: { gt: 0 } }
        })
        const fullyUsedCount = await prisma.schoolPin.count({
            where: { batchId: batch.id, status: 'USED' } // Or usageCount == maxUsage
        })
        return {
            ...batch,
            totalPins: batch._count.pins,
            usedPins: usedCount,
            fullyUsedCount
        }
    }))

    res.status(StatusCodes.OK).json({ batches: batchesWithStats })
}

// ─── SCHOOL ADMIN: View Individual PINs (For Export/Printing) ─────────────
const getSchoolPins = async (req, res) => {
    const schoolId = req.user.schoolId
    const { batchId, status, pinType, search, page, limit } = req.query

    const pageNum = Number(page) || 1
    const limitNum = Number(limit) || 10
    const skip = (pageNum - 1) * limitNum

    const where = { schoolId }
    if (batchId) where.batchId = batchId
    if (status && status !== 'ALL') where.status = status
    if (pinType && pinType !== 'ALL') where.pinType = pinType

    if (search) {
        where.OR = [
            { serialNumber: { contains: search, mode: 'insensitive' } },
            { pinCode: { contains: search, mode: 'insensitive' } }
        ]
    }

    const [rawPins, total] = await Promise.all([
        prisma.schoolPin.findMany({
            where,
            orderBy: { serialNumber: 'asc' },
            include: {
                student: {
                    select: {
                        admissionNo: true,
                        user: { select: { name: true } }
                    }
                },
                batch: { select: { batchNumber: true, pricePerPin: true } }
            },
            skip,
            take: limitNum
        }),
        prisma.schoolPin.count({ where })
    ])

    // Normalise student shape and mask PINs
    const pins = rawPins.map(p => {
        const pinCode = (p.status === 'ACTIVE' && p.usageCount === 0)
            ? p.pinCode
            : `${p.pinCode.substring(0, 4)}********${p.pinCode.substring(p.pinCode.length - 2)}`

        if (!p.student) return { ...p, pinCode }
        const parts = (p.student.user?.name || '').split(' ')
        return {
            ...p,
            pinCode,
            student: {
                firstName: parts[0] || '',
                lastName: parts.slice(1).join(' ') || '',
                admissionNo: p.student.admissionNo
            }
        }
    })

    res.status(StatusCodes.OK).json({ 
        pins,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum)
    })
}

// ─── STUDENT/PARENT: Validate and Consume PIN ─────────────────────────────
const validateAndLinkPin = async (req, res) => {
    const { pinCode, pinType = 'RESULT_CHECKING', usageContext = 'RESULT_VERIFICATION', action = 'VIEWED_TERM_RESULT', metadata } = req.body
    const schoolId = req.user.schoolId
    const userId = req.user.userId

    if (!pinCode) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'PIN code is required.' })
    }

    // Resolve real student profile ID instead of accepting User.id from frontend
    const studentProfile = await prisma.studentProfile.findUnique({ where: { userId } })
    if (!studentProfile) {
        throw new CustomError.BadRequestError('Student profile not found for this user.')
    }
    const studentProfileId = studentProfile.id

    // Wrap in transaction to prevent race conditions during usage increment
    const result = await prisma.$transaction(async (tx) => {
        const pin = await tx.schoolPin.findUnique({
            where: { pinCode }
        })

        if (!pin) {
            throw new CustomError.BadRequestError('Invalid PIN code.')
        }

        if (pin.schoolId !== schoolId) {
            throw new CustomError.BadRequestError('This PIN is not valid for this school.')
        }

        if (pin.pinType !== pinType) {
            throw new CustomError.BadRequestError(`Invalid PIN type. Expected ${pinType} but found ${pin.pinType}.`)
        }

        if (pin.status !== 'ACTIVE' || pin.usageCount >= pin.maxUsage) {
            throw new CustomError.BadRequestError('This PIN has expired or reached its maximum usage limit.')
        }

        // Check if pin is bound to another student
        if (pin.studentId && pin.studentId !== studentProfileId) {
            throw new CustomError.BadRequestError('This PIN has already been registered to another student.')
        }

        // Increment usage and bind to student
        const newUsageCount = pin.usageCount + 1
        const newStatus = newUsageCount >= pin.maxUsage ? 'USED' : 'ACTIVE'

        const updatedPin = await tx.schoolPin.update({
            where: { id: pin.id },
            data: {
                studentId: studentProfileId,
                usageCount: newUsageCount,
                status: newStatus
                // optionally set expiresAt if it's the first time being used and we want a 1-year expiry
            }
        })

        // Log the usage
        await tx.pinUsageLog.create({
            data: {
                pinId: pin.id,
                usageContext,
                action,
                metadata: metadata || {},
                usedByIdentifier: studentProfileId
            }
        })

        return updatedPin
    })

    res.status(StatusCodes.OK).json({
        message: 'PIN validated successfully.',
        pin: {
            usageCount: result.usageCount,
            maxUsage: result.maxUsage,
            status: result.status
        }
    })
}

module.exports = {
    getSchoolBatches,
    getSchoolPins,
    validateAndLinkPin
}
