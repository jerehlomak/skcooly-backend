const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

const getFinanceDashboard = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    
    // In Phase 1 we return zeroed stats if none found or we aggregate what we can
    // Using simple aggregations that work even with empty tables
    
    // We will aggregate `FinanceInvoice` and `StudentWallet`
    const invoices = await prisma.financeInvoice.aggregate({
        where: { schoolId, ...(activeBranchId && { branchId: activeBranchId }), isDeleted: false },
        _sum: { totalAmount: true, amountPaid: true, balanceDue: true }
    });

    const wallets = await prisma.studentWallet.aggregate({
        where: { 
            schoolId,
            ...(activeBranchId && { branchId: activeBranchId })
        },
        _sum: { balance: true }
    });

    // We can also count fee definitions
    const activeFeesCount = await prisma.feeDefinition.count({
        where: { schoolId, isActive: true, isDeleted: false }
    });

    res.status(StatusCodes.OK).json({
        stats: {
            expectedFees: invoices._sum.totalAmount || 0,
            collectedFees: invoices._sum.amountPaid || 0,
            outstandingBalance: invoices._sum.balanceDue || 0,
            totalWalletBalance: wallets._sum.balance || 0,
            activeFeesCount
        }
    });
};

// ─── SETTINGS ────────────────────────────────────────────────────────────────

const getFinanceSettings = async (req, res) => {
    const { schoolId } = req.user;

    let settings = await prisma.financeSettings.findUnique({
        where: { schoolId }
    });

    if (!settings) {
        settings = await prisma.financeSettings.create({
            data: { schoolId }
        });
    }

    res.status(StatusCodes.OK).json({ settings });
};

const updateFinanceSettings = async (req, res) => {
    const { schoolId } = req.user;
    
    // Extract updateable fields safely
    const { currencySymbol, invoicePrefix, receiptPrefix, allowPartialPayment, allowOverpayment, autoApplyWallet, showOptionalFees, enableTransport, financeModuleToggles } = req.body;

    const settings = await prisma.financeSettings.upsert({
        where: { schoolId },
        update: {
            currencySymbol, invoicePrefix, receiptPrefix, allowPartialPayment, allowOverpayment, autoApplyWallet, showOptionalFees, enableTransport,
            ...(financeModuleToggles && { financeModuleToggles })
        },
        create: {
            schoolId, currencySymbol, invoicePrefix, receiptPrefix, allowPartialPayment, allowOverpayment, autoApplyWallet, showOptionalFees, enableTransport,
            ...(financeModuleToggles && { financeModuleToggles })
        }
    });

    res.status(StatusCodes.OK).json({ settings, msg: 'Finance settings updated' });
};

// ─── FEE DEFINITIONS ────────────────────────────────────────────────────────

const getFeeDefinitions = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;

    const fees = await prisma.feeDefinition.findMany({
        where: {
            schoolId,
            ...(activeBranchId && { branchId: activeBranchId }),
            isDeleted: false
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ fees, count: fees.length });
};

const createFeeDefinition = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const data = req.body;

    const fee = await prisma.feeDefinition.create({
        data: {
            schoolId,
            branchId: activeBranchId || undefined,
            name: data.name,
            code: data.code,
            type: data.type || 'FEE',
            category: data.category || 'TUITION',
            amount: Number(data.amount) || 0,
            quantity: data.quantity ? Number(data.quantity) : null,
            studentType: data.studentType || 'BOTH',
            scope: data.scope || 'WHOLE_SCHOOL',
            termScope: data.termScope || 'ANNUAL',
            isCompulsory: data.isCompulsory !== undefined ? data.isCompulsory : true,
            allowInstallment: !!data.allowInstallment,
            dueDate: data.dueDate ? new Date(data.dueDate) : null
        }
    });

    res.status(StatusCodes.CREATED).json({ fee, msg: 'Fee definition created' });
};

const updateFeeDefinition = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;
    
    // ensure belongs to school
    const existing = await prisma.feeDefinition.findUnique({ where: { id } });
    if(!existing || existing.schoolId !== schoolId || existing.isDeleted) {
        throw new CustomError.NotFoundError('Fee definition not found');
    }

    const fee = await prisma.feeDefinition.update({
        where: { id },
        data: {
            ...req.body,
            amount: req.body.amount !== undefined ? Number(req.body.amount) : undefined,
            quantity: req.body.quantity !== undefined ? Number(req.body.quantity) : undefined,
            dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined
        }
    });

    res.status(StatusCodes.OK).json({ fee, msg: 'Fee definition updated' });
};

const deleteFeeDefinition = async (req, res) => {
    const { id } = req.params;
    const { schoolId, id: userId } = req.user;

    const existing = await prisma.feeDefinition.findUnique({ 
        where: { id },
        include: { assignments: true } 
    });
    
    if(!existing || existing.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Fee definition not found');
    }
    
    // Prevent hard-deleting historical records. (In Phase 2 we will check actual published invoices).
    // For now we lock it if it has been assigned.
    if (existing.assignments && existing.assignments.length > 0) {
        throw new CustomError.BadRequestError('Cannot delete fee definition actively assigned to students. Deactivate it instead.');
    }

    await prisma.feeDefinition.update({
        where: { id },
        data: { 
            isDeleted: true, 
            deletedAt: new Date(),
            deletedBy: userId
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Fee definition removed safely' });
};

// ─── WALLET BASE ────────────────────────────────────────────────────────────

const getStudentWallet = async (req, res) => {
    const { studentId } = req.params;
    const { schoolId } = req.user;

    let wallet = await prisma.studentWallet.findUnique({
        where: { studentId }
    });

    if (!wallet) {
        const student = await prisma.studentProfile.findUnique({ where: { id: studentId } });
        if(!student || student.schoolId !== schoolId) {
            throw new CustomError.NotFoundError('Student not found');
        }
        wallet = await prisma.studentWallet.create({
            data: { 
                schoolId, 
                studentId,
                branchId: student.branchId
            }
        });
    }

    const transactions = await prisma.studentWalletTransaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        take: 50
    });

    res.status(StatusCodes.OK).json({ wallet, transactions });
};

const fundWallet = async (req, res) => {
    const { studentId, amount, type, description } = req.body;
    const { schoolId } = req.user;

    if(!studentId || !amount || amount <= 0) {
        throw new CustomError.BadRequestError('Valid studentId and amount > 0 required');
    }

    // Ensure wallet exists before hitting interactive transaction
    let walletCheck = await prisma.studentWallet.findUnique({ where: { studentId } });
    if (!walletCheck) {
        const student = await prisma.studentProfile.findUnique({ where: { id: studentId } });
        if(!student || student.schoolId !== schoolId) {
            throw new CustomError.NotFoundError('Student not found');
        }
        walletCheck = await prisma.studentWallet.create({ 
            data: { schoolId, studentId, branchId: student.branchId } 
        });
    }

    // Execute ATOMIC transaction protecting against race conditions
    const newTransaction = await prisma.$transaction(async (tx) => {
        // Atomic increment native query locks the value adjustment
        const updatedWallet = await tx.studentWallet.update({
            where: { studentId },
            data: { balance: { increment: Number(amount) } }
        });

        // Hard math constraint to logically guarantee no negatives exist
        if (updatedWallet.balance < 0) {
            throw new CustomError.BadRequestError("Wallet balance cannot fall below zero");
        }

        const balanceAfter = updatedWallet.balance;
        const balanceBefore = balanceAfter - Number(amount);

        // Record the chronological ledger strictly using the atomically verified bounds
        return await tx.studentWalletTransaction.create({
            data: {
                walletId: updatedWallet.id,
                schoolId,
                branchId: updatedWallet.branchId,
                type: type || 'DEPOSIT',
                amount: Number(amount),
                balanceBefore,
                balanceAfter,
                reference: `SWT-${Date.now()}-${Math.floor(Math.random()*1000)}`,
                description: description || 'Wallet Funding'
            }
        });
    });

    res.status(StatusCodes.OK).json({ transaction: newTransaction, msg: 'Wallet funded securely' });
};

module.exports = {
    getFinanceDashboard,
    getFinanceSettings,
    updateFinanceSettings,
    getFeeDefinitions,
    createFeeDefinition,
    updateFeeDefinition,
    deleteFeeDefinition,
    getStudentWallet,
    fundWallet
};
