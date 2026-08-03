const prisma = require('../db/prisma');
const CustomError = require('../errors');
const { StatusCodes } = require('http-status-codes');

// ─── POS CATALOG & CUSTOMER SEARCH ───────────────────────────────────────────

const getSellableCatalog = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { category, search } = req.query;

    const where = {
        schoolId,
        isDeleted: false,
        isActive: true,
        isSellable: true,
    };

    if (category && category !== 'ALL') {
        where.category = category;
    }
    if (search) {
        where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } },
            { barcode: { contains: search, mode: 'insensitive' } },
            { category: { contains: search, mode: 'insensitive' } },
        ];
    }

    const items = await prisma.inventoryItem.findMany({
        where,
        orderBy: { name: 'asc' },
    });

    const catalog = items.map(item => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        barcode: item.barcode,
        category: item.category,
        unit: item.unit,
        costPrice: item.costPrice,
        sellingPrice: item.sellingPrice,
        quantityOnHand: item.quantityOnHand,
        reorderLevel: item.reorderLevel,
        isLowStock: item.quantityOnHand <= item.reorderLevel,
        isOutOfStock: item.quantityOnHand <= 0,
    }));

    res.status(StatusCodes.OK).json({ items: catalog, total: catalog.length });
};

const searchStudentsForPos = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
        return res.status(StatusCodes.OK).json({ students: [] });
    }

    const query = q.trim();

    const students = await prisma.studentProfile.findMany({
        where: {
            user: { schoolId },
            OR: [
                { admissionNumber: { contains: query, mode: 'insensitive' } },
                { user: { name: { contains: query, mode: 'insensitive' } } },
                { user: { email: { contains: query, mode: 'insensitive' } } },
            ]
        },
        take: 10,
        include: {
            user: { select: { id: true, name: true, email: true } },
            class: { select: { id: true, name: true } },
            StudentWallet: { select: { id: true, balance: true, isFrozen: true } }
        }
    });

    const formatted = students.map(s => {
        const wallet = s.StudentWallet?.[0] || null;
        return {
            id: s.id,
            userId: s.user.id,
            name: s.user.name,
            email: s.user.email,
            admissionNumber: s.admissionNumber,
            className: s.class?.name || 'Unassigned',
            walletBalance: wallet?.balance || 0,
            isWalletFrozen: wallet?.isFrozen || false,
            walletId: wallet?.id || null
        };
    });

    res.status(StatusCodes.OK).json({ students: formatted });
};

// ─── PROCESS POS CHECKOUT ───────────────────────────────────────────────────

const processPosSale = async (req, res) => {
    const schoolId = req.user.schoolId;
    const cashierName = req.user.name || 'Store Cashier';
    const cashierId = req.user.userId || null;

    const {
        items, // [{ itemId, quantity, unitPrice, discount }]
        customerType = 'WALK_IN', // WALK_IN | STUDENT | STAFF | PARENT
        studentId,
        customerName,
        paymentMethod = 'CASH', // CASH | POS | TRANSFER | WALLET | SPLIT
        paymentReference,
        discount = 0,
        tax = 0,
        amountPaid,
        notes
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
        throw new CustomError.BadRequestError('Cart must contain at least one item');
    }

    // 1. Verify item stock on ground
    const itemIds = items.map(i => i.itemId).filter(Boolean);
    const dbItems = await prisma.inventoryItem.findMany({
        where: {
            id: { in: itemIds },
            schoolId,
            isDeleted: false
        }
    });

    const itemMap = new Map(dbItems.map(i => [i.id, i]));

    for (const cartItem of items) {
        const dbItem = itemMap.get(cartItem.itemId);
        if (!dbItem) {
            throw new CustomError.BadRequestError(`Item with ID ${cartItem.itemId} was not found in inventory`);
        }
        const reqQty = parseInt(cartItem.quantity) || 1;
        if (dbItem.quantityOnHand < reqQty) {
            throw new CustomError.BadRequestError(
                `Insufficient stock for "${dbItem.name}". Available on ground: ${dbItem.quantityOnHand} ${dbItem.unit}, requested: ${reqQty}`
            );
        }
    }

    // 2. Compute sale calculations
    let calculatedSubtotal = 0;
    const lineItemsData = items.map(cartItem => {
        const dbItem = itemMap.get(cartItem.itemId);
        const unitPrice = cartItem.unitPrice !== undefined ? Number(cartItem.unitPrice) : dbItem.sellingPrice;
        const qty = parseInt(cartItem.quantity) || 1;
        const itemDiscount = Number(cartItem.discount) || 0;
        const lineTotal = Math.max(0, (unitPrice * qty) - itemDiscount);

        calculatedSubtotal += lineTotal;

        return {
            inventoryItemId: dbItem.id,
            itemName: dbItem.name,
            sku: dbItem.sku,
            unitPrice,
            quantity: qty,
            discount: itemDiscount,
            totalPrice: Math.round(lineTotal * 100) / 100
        };
    });

    const totalDiscount = Number(discount) || 0;
    const totalTax = Number(tax) || 0;
    const finalTotal = Math.max(0, Math.round((calculatedSubtotal - totalDiscount + totalTax) * 100) / 100);
    const tendered = amountPaid !== undefined ? Number(amountPaid) : finalTotal;
    const change = Math.max(0, Math.round((tendered - finalTotal) * 100) / 100);

    // 3. If paying via WALLET, verify and deduct student wallet
    let targetStudent = null;
    if (studentId) {
        targetStudent = await prisma.studentProfile.findFirst({
            where: { id: studentId },
            include: {
                user: { select: { name: true } },
                class: { select: { name: true } },
                StudentWallet: true
            }
        });
    }

    if (paymentMethod === 'WALLET') {
        if (!targetStudent) {
            throw new CustomError.BadRequestError('A valid student must be selected to pay via wallet');
        }
        const wallet = targetStudent.StudentWallet?.[0];
        if (!wallet) {
            throw new CustomError.BadRequestError(`No active wallet found for student ${targetStudent.user.name}`);
        }
        if (wallet.isFrozen) {
            throw new CustomError.BadRequestError('Student wallet is frozen and cannot be used');
        }
        if (wallet.balance < finalTotal) {
            throw new CustomError.BadRequestError(
                `Insufficient wallet balance. Available: ₦${wallet.balance.toLocaleString()}, Required: ₦${finalTotal.toLocaleString()}`
            );
        }
    }

    // 4. Generate unique sale number
    const timestamp = Date.now().toString().slice(-6);
    const randomHex = Math.floor(1000 + Math.random() * 9000);
    const saleNumber = `POS-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${timestamp}${randomHex}`;

    // 5. Execute transaction: Create PosSale, PosSaleItems, Deduct inventory, Log movements, Deduct wallet if needed
    const result = await prisma.$transaction(async (tx) => {
        // Create POS Sale record
        const sale = await tx.posSale.create({
            data: {
                schoolId,
                saleNumber,
                customerType,
                studentId: studentId || null,
                customerName: customerName?.trim() || (targetStudent ? targetStudent.user.name : 'Walk-in Customer'),
                studentAdmNo: targetStudent?.admissionNumber || null,
                studentClass: targetStudent?.class?.name || null,
                cashierId,
                cashierName,
                subtotal: Math.round(calculatedSubtotal * 100) / 100,
                discount: totalDiscount,
                tax: totalTax,
                totalAmount: finalTotal,
                amountPaid: tendered,
                change,
                paymentMethod,
                paymentReference: paymentReference?.trim() || null,
                status: 'COMPLETED',
                notes: notes?.trim() || null,
                items: {
                    create: lineItemsData
                }
            },
            include: {
                items: true
            }
        });

        // Deduct inventory & log movements
        for (const item of lineItemsData) {
            const dbItem = itemMap.get(item.inventoryItemId);
            const prevQty = dbItem.quantityOnHand;
            const newQty = Math.max(0, prevQty - item.quantity);

            await tx.inventoryItem.update({
                where: { id: item.inventoryItemId },
                data: { quantityOnHand: newQty }
            });

            await tx.inventoryMovement.create({
                data: {
                    schoolId,
                    itemId: item.inventoryItemId,
                    type: 'POS_SALE',
                    quantityChange: -item.quantity,
                    previousQuantity: prevQty,
                    newQuantity: newQty,
                    unitPrice: item.unitPrice,
                    referenceId: sale.id,
                    reason: `Sold via POS #${sale.saleNumber} (${sale.customerName})`,
                    performedBy: cashierName,
                }
            });
        }

        // Deduct wallet if applicable
        if (paymentMethod === 'WALLET' && targetStudent?.StudentWallet?.[0]) {
            const wallet = targetStudent.StudentWallet[0];
            const newBalance = wallet.balance - finalTotal;

            await tx.studentWallet.update({
                where: { id: wallet.id },
                data: { balance: newBalance }
            });

            await tx.studentWalletTransaction.create({
                data: {
                    schoolId,
                    walletId: wallet.id,
                    studentId: targetStudent.id,
                    type: 'DEBIT',
                    amount: finalTotal,
                    balanceBefore: wallet.balance,
                    balanceAfter: newBalance,
                    description: `POS Store Purchase - #${sale.saleNumber}`,
                    reference: sale.saleNumber,
                    status: 'SUCCESS'
                }
            });
        }

        return sale;
    });

    // Fetch school settings for receipt header
    const schoolSettings = await prisma.schoolSettings.findFirst({
        where: { schoolId }
    });

    res.status(StatusCodes.CREATED).json({
        message: 'POS sale completed successfully',
        sale: result,
        receipt: {
            saleNumber: result.saleNumber,
            date: result.createdAt,
            schoolName: schoolSettings?.schoolName || 'School Store',
            schoolAddress: schoolSettings?.address || '',
            schoolPhone: schoolSettings?.phone || '',
            cashier: result.cashierName,
            customerName: result.customerName,
            customerType: result.customerType,
            studentAdmNo: result.studentAdmNo,
            studentClass: result.studentClass,
            items: result.items,
            subtotal: result.subtotal,
            discount: result.discount,
            tax: result.tax,
            totalAmount: result.totalAmount,
            amountPaid: result.amountPaid,
            change: result.change,
            paymentMethod: result.paymentMethod,
            paymentReference: result.paymentReference
        }
    });
};

// ─── POS SALES HISTORY & CASHIER SUMMARY ─────────────────────────────────────

const getPosSales = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { timeRange, paymentMethod, status, search, limit = 50 } = req.query;

    const where = { schoolId };

    if (paymentMethod && paymentMethod !== 'ALL') {
        where.paymentMethod = paymentMethod;
    }
    if (status && status !== 'ALL') {
        where.status = status;
    }

    // Date filtering
    if (timeRange === 'TODAY') {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        where.createdAt = { gte: startOfDay };
    } else if (timeRange === 'THIS_WEEK') {
        const startOfWeek = new Date();
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        where.createdAt = { gte: startOfWeek };
    } else if (timeRange === 'THIS_MONTH') {
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        where.createdAt = { gte: startOfMonth };
    }

    if (search) {
        where.OR = [
            { saleNumber: { contains: search, mode: 'insensitive' } },
            { customerName: { contains: search, mode: 'insensitive' } },
            { studentAdmNo: { contains: search, mode: 'insensitive' } },
            { cashierName: { contains: search, mode: 'insensitive' } },
        ];
    }

    const sales = await prisma.posSale.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit) || 50,
        include: {
            items: true
        }
    });

    res.status(StatusCodes.OK).json({ sales, total: sales.length });
};

const getPosSaleById = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params;

    const sale = await prisma.posSale.findFirst({
        where: { id, schoolId },
        include: {
            items: true
        }
    });

    if (!sale) {
        throw new CustomError.NotFoundError(`Sale with ID ${id} not found`);
    }

    const schoolSettings = await prisma.schoolSettings.findFirst({
        where: { schoolId }
    });

    res.status(StatusCodes.OK).json({
        sale,
        schoolInfo: {
            name: schoolSettings?.schoolName || 'School Store',
            address: schoolSettings?.address || '',
            phone: schoolSettings?.phone || '',
            email: schoolSettings?.email || ''
        }
    });
};

const voidPosSale = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { id } = req.params;
    const { reason } = req.body;

    const sale = await prisma.posSale.findFirst({
        where: { id, schoolId },
        include: { items: true }
    });

    if (!sale) {
        throw new CustomError.NotFoundError(`Sale with ID ${id} not found`);
    }

    if (sale.status === 'VOIDED' || sale.status === 'REFUNDED') {
        throw new CustomError.BadRequestError(`Sale is already ${sale.status.toLowerCase()}`);
    }

    await prisma.$transaction(async (tx) => {
        // Mark sale as VOIDED
        await tx.posSale.update({
            where: { id },
            data: {
                status: 'VOIDED',
                notes: reason ? `${sale.notes ? sale.notes + ' | ' : ''}VOID REASON: ${reason}` : sale.notes
            }
        });

        // Restore inventory quantities and log return movements
        for (const item of sale.items) {
            if (item.inventoryItemId) {
                const dbItem = await tx.inventoryItem.findUnique({
                    where: { id: item.inventoryItemId }
                });

                if (dbItem) {
                    const prevQty = dbItem.quantityOnHand;
                    const newQty = prevQty + item.quantity;

                    await tx.inventoryItem.update({
                        where: { id: item.inventoryItemId },
                        data: { quantityOnHand: newQty }
                    });

                    await tx.inventoryMovement.create({
                        data: {
                            schoolId,
                            itemId: item.inventoryItemId,
                            type: 'RETURN',
                            quantityChange: item.quantity,
                            previousQuantity: prevQty,
                            newQuantity: newQty,
                            unitPrice: item.unitPrice,
                            referenceId: sale.id,
                            reason: `Stock restored from voided POS sale #${sale.saleNumber}`,
                            performedBy: req.user.name || 'Store Manager',
                        }
                    });
                }
            }
        }

        // Refund wallet if sale was paid via wallet
        if (sale.paymentMethod === 'WALLET' && sale.studentId) {
            const student = await tx.studentProfile.findUnique({
                where: { id: sale.studentId },
                include: { StudentWallet: true }
            });
            const wallet = student?.StudentWallet?.[0];
            if (wallet) {
                const newBalance = wallet.balance + sale.totalAmount;
                await tx.studentWallet.update({
                    where: { id: wallet.id },
                    data: { balance: newBalance }
                });
                await tx.studentWalletTransaction.create({
                    data: {
                        schoolId,
                        walletId: wallet.id,
                        studentId: student.id,
                        type: 'CREDIT',
                        amount: sale.totalAmount,
                        balanceBefore: wallet.balance,
                        balanceAfter: newBalance,
                        description: `POS Refund - Voided Sale #${sale.saleNumber}`,
                        reference: `REFUND-${sale.saleNumber}`,
                        status: 'SUCCESS'
                    }
                });
            }
        }
    });

    res.status(StatusCodes.OK).json({ message: 'POS sale voided and stock successfully restored' });
};

const getDailyCashierSummary = async (req, res) => {
    const schoolId = req.user.schoolId;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todaySales = await prisma.posSale.findMany({
        where: {
            schoolId,
            createdAt: { gte: startOfDay }
        }
    });

    let totalRevenue = 0;
    let completedCount = 0;
    let voidedCount = 0;
    let cashTotal = 0;
    let posCardTotal = 0;
    let transferTotal = 0;
    let walletTotal = 0;

    todaySales.forEach(sale => {
        if (sale.status === 'COMPLETED') {
            completedCount++;
            totalRevenue += sale.totalAmount;

            if (sale.paymentMethod === 'CASH') cashTotal += sale.totalAmount;
            else if (sale.paymentMethod === 'POS') posCardTotal += sale.totalAmount;
            else if (sale.paymentMethod === 'TRANSFER') transferTotal += sale.totalAmount;
            else if (sale.paymentMethod === 'WALLET') walletTotal += sale.totalAmount;
            else {
                cashTotal += sale.totalAmount;
            }
        } else if (sale.status === 'VOIDED' || sale.status === 'REFUNDED') {
            voidedCount++;
        }
    });

    res.status(StatusCodes.OK).json({
        summary: {
            date: new Date().toISOString(),
            totalTransactions: todaySales.length,
            completedCount,
            voidedCount,
            totalRevenue: Math.round(totalRevenue * 100) / 100,
            cashTotal: Math.round(cashTotal * 100) / 100,
            posCardTotal: Math.round(posCardTotal * 100) / 100,
            transferTotal: Math.round(transferTotal * 100) / 100,
            walletTotal: Math.round(walletTotal * 100) / 100
        }
    });
};

module.exports = {
    getSellableCatalog,
    searchStudentsForPos,
    processPosSale,
    getPosSales,
    getPosSaleById,
    voidPosSale,
    getDailyCashierSummary
};
