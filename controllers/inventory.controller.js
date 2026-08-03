const prisma = require('../db/prisma');
const CustomError = require('../errors');
const { StatusCodes } = require('http-status-codes');

// ─── INVENTORY CATALOG CRUD ──────────────────────────────────────────────────

const getInventoryItems = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { category, status, isSellable, search } = req.query;

    const where = {
        schoolId,
        isDeleted: false,
    };

    if (category && category !== 'ALL') {
        where.category = category;
    }
    if (isSellable !== undefined && isSellable !== 'ALL') {
        where.isSellable = isSellable === 'true' || isSellable === true;
    }
    if (search) {
        where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } },
            { barcode: { contains: search, mode: 'insensitive' } },
            { location: { contains: search, mode: 'insensitive' } },
            { category: { contains: search, mode: 'insensitive' } },
        ];
    }

    const items = await prisma.inventoryItem.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
            restocks: {
                orderBy: { receivedDate: 'desc' },
                take: 1
            }
        }
    });

    // Compute stock status & apply status filtering in memory if requested
    let enriched = items.map(item => {
        let stockStatus = 'IN_STOCK';
        if (item.quantityOnHand <= 0) {
            stockStatus = 'OUT_OF_STOCK';
        } else if (item.quantityOnHand <= item.reorderLevel) {
            stockStatus = 'LOW_STOCK';
        }

        return {
            ...item,
            stockStatus,
            isLowStock: item.quantityOnHand <= item.reorderLevel,
            totalCostValue: Math.round(item.quantityOnHand * item.costPrice * 100) / 100,
            totalRetailValue: Math.round(item.quantityOnHand * item.sellingPrice * 100) / 100,
            lastRestockedAt: item.restocks?.[0]?.receivedDate || null
        };
    });

    if (status && status !== 'ALL') {
        enriched = enriched.filter(i => i.stockStatus === status);
    }

    res.status(StatusCodes.OK).json({ items: enriched, total: enriched.length });
};

const getInventoryItemById = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params;

    const item = await prisma.inventoryItem.findFirst({
        where: { id, schoolId, isDeleted: false },
        include: {
            restocks: {
                orderBy: { receivedDate: 'desc' },
                take: 10
            },
            movements: {
                orderBy: { createdAt: 'desc' },
                take: 20
            }
        }
    });

    if (!item) {
        throw new CustomError.NotFoundError(`Inventory item with ID ${id} not found`);
    }

    let stockStatus = 'IN_STOCK';
    if (item.quantityOnHand <= 0) stockStatus = 'OUT_OF_STOCK';
    else if (item.quantityOnHand <= item.reorderLevel) stockStatus = 'LOW_STOCK';

    res.status(StatusCodes.OK).json({
        item: {
            ...item,
            stockStatus,
            totalCostValue: Math.round(item.quantityOnHand * item.costPrice * 100) / 100,
            totalRetailValue: Math.round(item.quantityOnHand * item.sellingPrice * 100) / 100
        }
    });
};

const createInventoryItem = async (req, res) => {
    const schoolId = req.user.schoolId;
    const {
        sku,
        barcode,
        name,
        category,
        unit,
        costPrice,
        sellingPrice,
        initialQuantity,
        reorderLevel,
        isSellable,
        location,
        description
    } = req.body;

    if (!name || !category) {
        throw new CustomError.BadRequestError('Item name and Category are required');
    }

    const itemSku = sku?.trim() || `SKU-${Date.now().toString().slice(-6)}`;
    const cost = Number(costPrice) || 0;
    const price = Number(sellingPrice) || 0;
    const initialQty = Math.max(0, parseInt(initialQuantity) || 0);
    const reorder = Math.max(0, parseInt(reorderLevel) || 10);

    const newItem = await prisma.inventoryItem.create({
        data: {
            schoolId,
            sku: itemSku,
            barcode: barcode?.trim() || null,
            name: name.trim(),
            category,
            unit: unit?.trim() || 'Pieces',
            costPrice: cost,
            sellingPrice: price,
            quantityOnHand: initialQty,
            reorderLevel: reorder,
            isSellable: isSellable !== undefined ? Boolean(isSellable) : true,
            location: location?.trim() || null,
            description: description?.trim() || null,
        }
    });

    // Log initial stock creation in movement ledger if quantity > 0
    if (initialQty > 0) {
        await prisma.inventoryMovement.create({
            data: {
                schoolId,
                itemId: newItem.id,
                type: 'RESTOCK',
                quantityChange: initialQty,
                previousQuantity: 0,
                newQuantity: initialQty,
                unitPrice: cost,
                reason: 'Initial stock on item registration',
                performedBy: req.user.name || 'Store Admin',
            }
        });
    }

    res.status(StatusCodes.CREATED).json({
        message: 'Inventory item created successfully',
        item: newItem
    });
};

const updateInventoryItem = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params;

    const existing = await prisma.inventoryItem.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!existing) {
        throw new CustomError.NotFoundError(`Inventory item with ID ${id} not found`);
    }

    const {
        sku,
        barcode,
        name,
        category,
        unit,
        costPrice,
        sellingPrice,
        reorderLevel,
        isSellable,
        location,
        description,
        isActive
    } = req.body;

    const updated = await prisma.inventoryItem.update({
        where: { id },
        data: {
            sku: sku !== undefined ? sku.trim() : existing.sku,
            barcode: barcode !== undefined ? barcode?.trim() || null : existing.barcode,
            name: name !== undefined ? name.trim() : existing.name,
            category: category !== undefined ? category : existing.category,
            unit: unit !== undefined ? unit.trim() : existing.unit,
            costPrice: costPrice !== undefined ? Number(costPrice) : existing.costPrice,
            sellingPrice: sellingPrice !== undefined ? Number(sellingPrice) : existing.sellingPrice,
            reorderLevel: reorderLevel !== undefined ? Math.max(0, parseInt(reorderLevel)) : existing.reorderLevel,
            isSellable: isSellable !== undefined ? Boolean(isSellable) : existing.isSellable,
            location: location !== undefined ? location?.trim() : existing.location,
            description: description !== undefined ? description?.trim() : existing.description,
            isActive: isActive !== undefined ? Boolean(isActive) : existing.isActive,
        }
    });

    res.status(StatusCodes.OK).json({
        message: 'Inventory item updated successfully',
        item: updated
    });
};

const deleteInventoryItem = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params;

    const existing = await prisma.inventoryItem.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!existing) {
        throw new CustomError.NotFoundError(`Inventory item with ID ${id} not found`);
    }

    await prisma.inventoryItem.update({
        where: { id },
        data: {
            isDeleted: true,
            deletedAt: new Date()
        }
    });

    res.status(StatusCodes.OK).json({ message: 'Inventory item deleted successfully' });
};

// ─── STOCK IN / RESTOCKING ───────────────────────────────────────────────────

const restockInventory = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params; // itemId
    const {
        quantityAdded,
        unitCost,
        supplier,
        batchNumber,
        invoiceRef,
        receivedDate,
        receivedBy,
        notes
    } = req.body;

    const qty = parseInt(quantityAdded);
    if (isNaN(qty) || qty <= 0) {
        throw new CustomError.BadRequestError('Valid quantity added (greater than 0) is required');
    }

    const item = await prisma.inventoryItem.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!item) {
        throw new CustomError.NotFoundError(`Inventory item with ID ${id} not found`);
    }

    const cost = unitCost !== undefined ? Number(unitCost) : item.costPrice;
    const totalCost = cost * qty;
    const previousQty = item.quantityOnHand;
    const newQty = previousQty + qty;

    // Calculate weighted average cost price
    const currentTotalVal = previousQty * item.costPrice;
    const newTotalVal = currentTotalVal + totalCost;
    const weightedAvgCost = newQty > 0 ? Math.round((newTotalVal / newQty) * 100) / 100 : cost;

    // Execute atomic update
    const [restockRecord, updatedItem, movement] = await prisma.$transaction([
        prisma.inventoryRestock.create({
            data: {
                schoolId,
                itemId: id,
                batchNumber: batchNumber?.trim() || `BATCH-${Date.now().toString().slice(-6)}`,
                supplier: supplier?.trim() || null,
                invoiceRef: invoiceRef?.trim() || null,
                quantityAdded: qty,
                unitCost: cost,
                totalCost,
                receivedDate: receivedDate ? new Date(receivedDate) : new Date(),
                receivedBy: receivedBy?.trim() || req.user.name || 'Storekeeper',
                notes: notes?.trim() || null,
            }
        }),
        prisma.inventoryItem.update({
            where: { id },
            data: {
                quantityOnHand: newQty,
                costPrice: weightedAvgCost
            }
        }),
        prisma.inventoryMovement.create({
            data: {
                schoolId,
                itemId: id,
                type: 'RESTOCK',
                quantityChange: qty,
                previousQuantity: previousQty,
                newQuantity: newQty,
                unitPrice: cost,
                reason: supplier ? `Restocked from ${supplier}` : 'Stock In purchase batch',
                performedBy: req.user.name || 'Store Admin',
            }
        })
    ]);

    res.status(StatusCodes.CREATED).json({
        message: `Successfully restocked ${qty} ${item.unit} of ${item.name}`,
        item: updatedItem,
        restock: restockRecord
    });
};

// ─── STOCK OUT / USAGE / DAMAGE / ADJUSTMENT ─────────────────────────────────

const recordStockUsage = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params; // itemId
    const {
        quantity,
        type, // USAGE | DAMAGE | ADJUSTMENT | RETURN | EXPIRED
        reason,
        performedBy,
        notes
    } = req.body;

    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) {
        throw new CustomError.BadRequestError('Valid quantity (greater than 0) is required');
    }

    const item = await prisma.inventoryItem.findFirst({
        where: { id, schoolId, isDeleted: false }
    });

    if (!item) {
        throw new CustomError.NotFoundError(`Inventory item with ID ${id} not found`);
    }

    const movementType = type || 'USAGE';
    const previousQty = item.quantityOnHand;

    if (previousQty < qty && movementType !== 'ADJUSTMENT') {
        throw new CustomError.BadRequestError(`Insufficient stock on ground. Available: ${previousQty} ${item.unit}, requested: ${qty}`);
    }

    const newQty = Math.max(0, previousQty - qty);

    const [updatedItem, movement] = await prisma.$transaction([
        prisma.inventoryItem.update({
            where: { id },
            data: { quantityOnHand: newQty }
        }),
        prisma.inventoryMovement.create({
            data: {
                schoolId,
                itemId: id,
                type: movementType,
                quantityChange: -qty,
                previousQuantity: previousQty,
                newQuantity: newQty,
                unitPrice: item.costPrice,
                reason: reason?.trim() || `Internal ${movementType.toLowerCase()}${notes ? `: ${notes}` : ''}`,
                performedBy: performedBy?.trim() || req.user.name || 'Store Admin',
            }
        })
    ]);

    res.status(StatusCodes.CREATED).json({
        message: `Successfully recorded ${qty} ${item.unit} ${movementType.toLowerCase()}`,
        item: updatedItem,
        movement
    });
};

// ─── STOCK MOVEMENTS / STOCK CARD ────────────────────────────────────────────

const getItemMovements = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { itemId, type, limit } = req.query;

    const where = { schoolId };
    if (itemId) where.itemId = itemId;
    if (type && type !== 'ALL') where.type = type;

    const movements = await prisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit ? parseInt(limit) : 50,
        include: {
            item: {
                select: {
                    id: true,
                    name: true,
                    sku: true,
                    unit: true,
                    category: true
                }
            }
        }
    });

    res.status(StatusCodes.OK).json({ movements, total: movements.length });
};

// ─── INVENTORY VALUATION & ANALYTICS REPORT ──────────────────────────────────

const getInventoryValuationReport = async (req, res) => {
    const schoolId = req.user.schoolId;

    const items = await prisma.inventoryItem.findMany({
        where: { schoolId, isDeleted: false },
        orderBy: { name: 'asc' }
    });

    let totalSKUs = items.length;
    let totalStockQuantity = 0;
    let totalCostValue = 0;
    let totalRetailValue = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    const categoryBreakdown = {};
    const lowStockAlerts = [];

    items.forEach(item => {
        const qty = item.quantityOnHand || 0;
        const costVal = qty * (item.costPrice || 0);
        const retailVal = qty * (item.sellingPrice || 0);

        totalStockQuantity += qty;
        totalCostValue += costVal;
        totalRetailValue += retailVal;

        if (qty <= 0) {
            outOfStockCount++;
            lowStockAlerts.push({
                ...item,
                status: 'OUT_OF_STOCK'
            });
        } else if (qty <= item.reorderLevel) {
            lowStockCount++;
            lowStockAlerts.push({
                ...item,
                status: 'LOW_STOCK'
            });
        }

        if (!categoryBreakdown[item.category]) {
            categoryBreakdown[item.category] = {
                skuCount: 0,
                totalUnits: 0,
                costValue: 0,
                retailValue: 0
            };
        }
        categoryBreakdown[item.category].skuCount += 1;
        categoryBreakdown[item.category].totalUnits += qty;
        categoryBreakdown[item.category].costValue += costVal;
        categoryBreakdown[item.category].retailValue += retailVal;
    });

    const potentialGrossMargin = totalRetailValue > 0 
        ? Math.round(((totalRetailValue - totalCostValue) / totalRetailValue) * 100 * 100) / 100 
        : 0;

    res.status(StatusCodes.OK).json({
        report: {
            totalSKUs,
            totalStockQuantity,
            totalCostValue: Math.round(totalCostValue * 100) / 100,
            totalRetailValue: Math.round(totalRetailValue * 100) / 100,
            potentialGrossMargin,
            lowStockCount,
            outOfStockCount,
            totalAlertsCount: lowStockAlerts.length,
            categoryBreakdown,
            lowStockAlerts
        }
    });
};

module.exports = {
    getInventoryItems,
    getInventoryItemById,
    createInventoryItem,
    updateInventoryItem,
    deleteInventoryItem,
    restockInventory,
    recordStockUsage,
    getItemMovements,
    getInventoryValuationReport
};
