
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
    let fees = await prisma.feeParticular.findMany({
        where: { schoolId: req.user.schoolId, isDeleted: false },
        orderBy: { createdAt: 'asc' }
    })

    if (fees.length === 0) {
        // Seed defaults
        const defaultsWithSchool = DEFAULTS.map(d => ({ ...d, schoolId: req.user.schoolId }));
        await prisma.feeParticular.createMany({ data: defaultsWithSchool })
        fees = await prisma.feeParticular.findMany({
            where: { schoolId: req.user.schoolId, isDeleted: false },
            orderBy: { createdAt: 'asc' }
        })
    }

    res.status(StatusCodes.OK).json({ fees, count: fees.length })
}

// POST bulk upload (upsert by label — avoids ID churn that breaks assignment validation)
const syncFeeParticulars = async (req, res) => {
    const { fees } = req.body

    if (!Array.isArray(fees)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Expected an array of fees' })
    }

    const schoolId = req.user.schoolId;

    await prisma.$transaction(async (tx) => {
        // Fetch existing active fee particulars for this school
        const existing = await tx.feeParticular.findMany({
            where: { schoolId, isDeleted: false }
        });

        const existingLabels = new Map(existing.map(e => [e.label.toLowerCase().trim(), e]));
        const incomingLabels = new Set(fees.map(f => (f.label || '').toLowerCase().trim()));

        // Soft-delete any FPs that are no longer in the incoming list
        const toDelete = existing.filter(e => !incomingLabels.has(e.label.toLowerCase().trim()));
        if (toDelete.length > 0) {
            await tx.feeParticular.updateMany({
                where: { id: { in: toDelete.map(d => d.id) } },
                data: { isDeleted: true, deletedAt: new Date() }
            });
        }

        // Upsert each incoming fee by label — update if exists, create if new
        for (const f of fees) {
            const label = (f.label || 'Unnamed Fee').trim();
            const amount = parseFloat(f.amount) || 0;
            const isRequired = Boolean(f.isRequired);
            const isFixed = Boolean(f.isFixed);

            const existing = existingLabels.get(label.toLowerCase());
            if (existing) {
                // Update existing record — keep same ID
                await tx.feeParticular.update({
                    where: { id: existing.id },
                    data: { amount, isRequired, isFixed, isDeleted: false, deletedAt: null }
                });
            } else {
                // Create new record
                await tx.feeParticular.create({
                    data: { label, amount, isRequired, isFixed, schoolId }
                });
            }
        }
    });

    const updatedFees = await prisma.feeParticular.findMany({
        where: { schoolId, isDeleted: false },
        orderBy: { createdAt: 'asc' }
    });

    res.status(StatusCodes.OK).json({ msg: 'Fees synced successfully', fees: updatedFees })
}

// DELETE a single fee particular
const deleteFeeParticular = async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.schoolId;

    const fee = await prisma.feeParticular.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!fee) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: 'Fee particular not found' });
    }

    await prisma.feeParticular.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() }
    });

    res.status(StatusCodes.OK).json({ msg: `"${fee.label}" deleted successfully` });
}

module.exports = { getFeeParticulars, syncFeeParticulars, deleteFeeParticular }
