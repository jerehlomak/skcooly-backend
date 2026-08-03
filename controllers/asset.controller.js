const prisma = require('../db/prisma');
const CustomError = require('../errors');
const { StatusCodes } = require('http-status-codes');

/**
 * Calculates straight-line depreciation and current book value
 */
const calculateBookValue = (purchaseCost, salvageValue = 0, usefulLifeYears = 5, purchaseDate = new Date()) => {
    const cost = Number(purchaseCost) || 0;
    const salvage = Number(salvageValue) || 0;
    const years = Number(usefulLifeYears) || 5;
    if (cost <= 0) return 0;
    
    const pDate = new Date(purchaseDate || Date.now());
    const now = new Date();
    const elapsedYears = Math.max(0, (now - pDate) / (1000 * 60 * 60 * 24 * 365.25));
    
    const depreciableBase = Math.max(0, cost - salvage);
    const annualDepreciation = years > 0 ? depreciableBase / years : 0;
    const accumulatedDepreciation = Math.min(depreciableBase, annualDepreciation * elapsedYears);
    
    const currentBookValue = Math.max(salvage, cost - accumulatedDepreciation);
    return Math.round(currentBookValue * 100) / 100;
};

// ─── ASSET REGISTRY CRUD ─────────────────────────────────────────────────────

const getAssets = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { category, location, condition, search } = req.query;

    const where = {
        schoolId,
        isDeleted: false,
    };

    if (category && category !== 'ALL') {
        where.category = category;
    }
    if (location && location !== 'ALL') {
        where.location = { contains: location, mode: 'insensitive' };
    }
    if (condition && condition !== 'ALL') {
        where.condition = condition;
    }
    if (search) {
        where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { assetTag: { contains: search, mode: 'insensitive' } },
            { serialNumber: { contains: search, mode: 'insensitive' } },
            { assignedStaffName: { contains: search, mode: 'insensitive' } },
            { vendor: { contains: search, mode: 'insensitive' } },
            { location: { contains: search, mode: 'insensitive' } },
        ];
    }

    const assets = await prisma.schoolAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
            auditRecords: {
                orderBy: { auditDate: 'desc' },
                take: 1
            }
        }
    });

    // Recalculate live book value for presentation
    const enrichedAssets = assets.map(asset => {
        const liveValue = calculateBookValue(
            asset.purchaseCost,
            asset.salvageValue,
            asset.usefulLifeYears,
            asset.purchaseDate
        );
        return {
            ...asset,
            currentValue: liveValue,
            lastAuditedAt: asset.auditRecords?.[0]?.auditDate || null,
            lastAuditStatus: asset.auditRecords?.[0]?.status || null,
        };
    });

    res.status(StatusCodes.OK).json({ assets: enrichedAssets, total: enrichedAssets.length });
};

const getAssetById = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params;

    const asset = await prisma.schoolAsset.findFirst({
        where: { id, schoolId, isDeleted: false },
        include: {
            auditRecords: {
                orderBy: { auditDate: 'desc' }
            }
        }
    });

    if (!asset) {
        throw new CustomError.NotFoundError(`Asset with ID ${id} not found`);
    }

    const liveValue = calculateBookValue(
        asset.purchaseCost,
        asset.salvageValue,
        asset.usefulLifeYears,
        asset.purchaseDate
    );

    res.status(StatusCodes.OK).json({ asset: { ...asset, currentValue: liveValue } });
};

const createAsset = async (req, res) => {
    const schoolId = req.user.schoolId;
    const {
        assetTag,
        name,
        category,
        location,
        quantity,
        purchaseDate,
        purchaseCost,
        salvageValue,
        usefulLifeYears,
        depreciationRate,
        condition,
        assignedStaffId,
        assignedStaffName,
        serialNumber,
        vendor,
        warrantyExpiry,
        notes
    } = req.body;

    if (!name || !category || !location) {
        throw new CustomError.BadRequestError('Name, Category, and Location are required');
    }

    const tag = assetTag?.trim() || `AST-${Date.now().toString().slice(-6)}`;
    const cost = Number(purchaseCost) || 0;
    const salvage = Number(salvageValue) || 0;
    const years = Number(usefulLifeYears) || 5;
    const qty = Number(quantity) || 1;
    const pDate = purchaseDate ? new Date(purchaseDate) : new Date();

    const bookValue = calculateBookValue(cost, salvage, years, pDate);
    const depRate = Number(depreciationRate) || (years > 0 ? Math.round((100 / years) * 100) / 100 : 20);

    const newAsset = await prisma.schoolAsset.create({
        data: {
            schoolId,
            assetTag: tag,
            name: name.trim(),
            category,
            location: location.trim(),
            quantity: qty,
            purchaseDate: pDate,
            purchaseCost: cost,
            salvageValue: salvage,
            usefulLifeYears: years,
            depreciationRate: depRate,
            currentValue: bookValue,
            condition: condition || 'GOOD',
            assignedStaffId: assignedStaffId || null,
            assignedStaffName: assignedStaffName?.trim() || null,
            serialNumber: serialNumber?.trim() || null,
            vendor: vendor?.trim() || null,
            warrantyExpiry: warrantyExpiry ? new Date(warrantyExpiry) : null,
            notes: notes?.trim() || null,
        }
    });

    res.status(StatusCodes.CREATED).json({
        message: 'Asset registered successfully',
        asset: newAsset
    });
};

const updateAsset = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params;

    const existing = await prisma.schoolAsset.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!existing) {
        throw new CustomError.NotFoundError(`Asset with ID ${id} not found`);
    }

    const {
        assetTag,
        name,
        category,
        location,
        quantity,
        purchaseDate,
        purchaseCost,
        salvageValue,
        usefulLifeYears,
        depreciationRate,
        condition,
        assignedStaffId,
        assignedStaffName,
        serialNumber,
        vendor,
        warrantyExpiry,
        notes
    } = req.body;

    const cost = purchaseCost !== undefined ? Number(purchaseCost) : existing.purchaseCost;
    const salvage = salvageValue !== undefined ? Number(salvageValue) : existing.salvageValue;
    const years = usefulLifeYears !== undefined ? Number(usefulLifeYears) : existing.usefulLifeYears;
    const pDate = purchaseDate !== undefined ? (purchaseDate ? new Date(purchaseDate) : null) : existing.purchaseDate;
    const bookValue = calculateBookValue(cost, salvage, years, pDate);

    const updated = await prisma.schoolAsset.update({
        where: { id },
        data: {
            assetTag: assetTag !== undefined ? assetTag.trim() : existing.assetTag,
            name: name !== undefined ? name.trim() : existing.name,
            category: category !== undefined ? category : existing.category,
            location: location !== undefined ? location.trim() : existing.location,
            quantity: quantity !== undefined ? Number(quantity) : existing.quantity,
            purchaseDate: pDate,
            purchaseCost: cost,
            salvageValue: salvage,
            usefulLifeYears: years,
            depreciationRate: depreciationRate !== undefined ? Number(depreciationRate) : existing.depreciationRate,
            currentValue: bookValue,
            condition: condition !== undefined ? condition : existing.condition,
            assignedStaffId: assignedStaffId !== undefined ? assignedStaffId : existing.assignedStaffId,
            assignedStaffName: assignedStaffName !== undefined ? assignedStaffName?.trim() : existing.assignedStaffName,
            serialNumber: serialNumber !== undefined ? serialNumber?.trim() : existing.serialNumber,
            vendor: vendor !== undefined ? vendor?.trim() : existing.vendor,
            warrantyExpiry: warrantyExpiry !== undefined ? (warrantyExpiry ? new Date(warrantyExpiry) : null) : existing.warrantyExpiry,
            notes: notes !== undefined ? notes?.trim() : existing.notes,
        }
    });

    res.status(StatusCodes.OK).json({
        message: 'Asset updated successfully',
        asset: updated
    });
};

const deleteAsset = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params;

    const existing = await prisma.schoolAsset.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!existing) {
        throw new CustomError.NotFoundError(`Asset with ID ${id} not found`);
    }

    await prisma.schoolAsset.update({
        where: { id },
        data: {
            isDeleted: true,
            deletedAt: new Date()
        }
    });

    res.status(StatusCodes.OK).json({ message: 'Asset deleted successfully' });
};

// ─── PHYSICAL AUDIT & GROUND CHECKS ("Asset and Liability Check") ─────────────

const recordAssetAudit = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params; // assetId
    const {
        actualQuantity,
        condition,
        location,
        auditorName,
        updateGroundRecord,
        notes
    } = req.body;

    const asset = await prisma.schoolAsset.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!asset) {
        throw new CustomError.NotFoundError(`Asset with ID ${id} not found`);
    }

    const expectedQty = asset.quantity;
    const actualQty = Number(actualQuantity);
    if (isNaN(actualQty) || actualQty < 0) {
        throw new CustomError.BadRequestError('Valid actual quantity is required');
    }

    const discrepancy = actualQty - expectedQty;
    const auditStatus = discrepancy === 0 ? 'VERIFIED' : (discrepancy < 0 ? 'FLAGGED' : 'DISCREPANCY');

    const auditRecord = await prisma.assetAuditRecord.create({
        data: {
            schoolId,
            assetId: id,
            auditDate: new Date(),
            auditorId: req.user.userId || null,
            auditorName: auditorName?.trim() || req.user.name || 'School Auditor',
            expectedQuantity: expectedQty,
            actualQuantity: actualQty,
            discrepancy,
            condition: condition || asset.condition,
            location: location?.trim() || asset.location,
            status: auditStatus,
            notes: notes?.trim() || null,
        }
    });

    // Optionally update the live asset record to match ground verification
    if (updateGroundRecord) {
        await prisma.schoolAsset.update({
            where: { id },
            data: {
                quantity: actualQty,
                condition: condition || asset.condition,
                location: location?.trim() || asset.location,
            }
        });
    }

    res.status(StatusCodes.CREATED).json({
        message: 'Physical audit recorded successfully',
        audit: auditRecord
    });
};

const getAssetAuditHistory = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { assetId, status } = req.query;

    const where = { schoolId };
    if (assetId) where.assetId = assetId;
    if (status && status !== 'ALL') where.status = status;

    const records = await prisma.assetAuditRecord.findMany({
        where,
        orderBy: { auditDate: 'desc' },
        include: {
            asset: {
                select: {
                    id: true,
                    name: true,
                    assetTag: true,
                    category: true,
                    location: true
                }
            }
        }
    });

    res.status(StatusCodes.OK).json({ audits: records, total: records.length });
};

// ─── VALUATION & REPORTS SUMMARY ─────────────────────────────────────────────

const getAssetValuationSummary = async (req, res) => {
    const schoolId = req.user.schoolId;

    const assets = await prisma.schoolAsset.findMany({
        where: { schoolId, isDeleted: false }
    });

    let totalAssetCount = 0;
    let totalAcquisitionCost = 0;
    let totalCurrentValue = 0;
    let totalSalvageValue = 0;
    let needingRepairCount = 0;
    let damagedOrMissingCount = 0;

    const categoryBreakdown = {};
    const conditionBreakdown = {
        GOOD: 0,
        FAIR: 0,
        NEEDS_REPAIR: 0,
        DAMAGED: 0,
        MISSING: 0,
        DISPOSED: 0
    };

    assets.forEach(asset => {
        const qty = asset.quantity || 1;
        const cost = (asset.purchaseCost || 0) * qty;
        const liveVal = calculateBookValue(
            asset.purchaseCost,
            asset.salvageValue,
            asset.usefulLifeYears,
            asset.purchaseDate
        ) * qty;

        totalAssetCount += qty;
        totalAcquisitionCost += cost;
        totalCurrentValue += liveVal;
        totalSalvageValue += (asset.salvageValue || 0) * qty;

        if (asset.condition === 'NEEDS_REPAIR') needingRepairCount += qty;
        if (asset.condition === 'DAMAGED' || asset.condition === 'MISSING') damagedOrMissingCount += qty;

        conditionBreakdown[asset.condition] = (conditionBreakdown[asset.condition] || 0) + qty;

        if (!categoryBreakdown[asset.category]) {
            categoryBreakdown[asset.category] = {
                count: 0,
                acquisitionCost: 0,
                currentValue: 0
            };
        }
        categoryBreakdown[asset.category].count += qty;
        categoryBreakdown[asset.category].acquisitionCost += cost;
        categoryBreakdown[asset.category].currentValue += liveVal;
    });

    const totalDepreciation = Math.max(0, totalAcquisitionCost - totalCurrentValue);

    // Count recent flagged audits
    const flaggedAuditsCount = await prisma.assetAuditRecord.count({
        where: {
            schoolId,
            status: { in: ['FLAGGED', 'DISCREPANCY'] }
        }
    });

    res.status(StatusCodes.OK).json({
        summary: {
            totalItemsCount: assets.length,
            totalAssetQuantity: totalAssetCount,
            totalAcquisitionCost: Math.round(totalAcquisitionCost * 100) / 100,
            totalCurrentValue: Math.round(totalCurrentValue * 100) / 100,
            totalDepreciation: Math.round(totalDepreciation * 100) / 100,
            totalSalvageValue: Math.round(totalSalvageValue * 100) / 100,
            needingRepairCount,
            damagedOrMissingCount,
            flaggedAuditsCount,
            categoryBreakdown,
            conditionBreakdown
        }
    });
};

module.exports = {
    getAssets,
    getAssetById,
    createAsset,
    updateAsset,
    deleteAsset,
    recordAssetAudit,
    getAssetAuditHistory,
    getAssetValuationSummary
};
