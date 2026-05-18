const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

const getFinanceDashboard = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { term, academicYear } = req.query;

    const invoiceWhere = {
        schoolId,
        isDeleted: false,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(term && { term }),
        ...(academicYear && { academicYear })
    };

    const [invoices, wallets, activeFeesCount, paidCount, partialCount, overdueCount, recentTx, methodAgg] = await Promise.all([
        prisma.financeInvoice.aggregate({
            where: invoiceWhere,
            _sum: { totalAmount: true, amountPaid: true, balanceDue: true },
            _count: { id: true }
        }),
        prisma.studentWallet.aggregate({
            where: { schoolId, ...(activeBranchId && { branchId: activeBranchId }) },
            _sum: { balance: true }
        }),
        prisma.feeDefinition.count({ where: { schoolId, isActive: true, isDeleted: false } }),
        prisma.financeInvoice.count({ where: { ...invoiceWhere, status: 'PAID' } }),
        prisma.financeInvoice.count({ where: { ...invoiceWhere, status: 'PARTIAL' } }),
        prisma.financeInvoice.count({ where: { ...invoiceWhere, status: { in: ['OPEN', 'DRAFT', 'SENT'] }, balanceDue: { gt: 0 } } }),
        prisma.paymentTransaction.findMany({
            where: { schoolId, status: 'SUCCESSFUL' },
            include: { student: { include: { user: { select: { name: true } } } } },
            orderBy: { paidAt: 'desc' },
            take: 8
        }),
        prisma.paymentTransaction.groupBy({
            by: ['method'],
            where: { schoolId, status: 'SUCCESSFUL' },
            _sum: { amount: true },
            _count: { id: true }
        })
    ]);

    const expectedFees = invoices._sum.totalAmount || 0;
    const collectedFees = invoices._sum.amountPaid || 0;
    const collectionRate = expectedFees > 0 ? Math.round((collectedFees / expectedFees) * 100) : 0;

    res.status(StatusCodes.OK).json({
        stats: {
            expectedFees,
            collectedFees,
            outstandingBalance: invoices._sum.balanceDue || 0,
            totalWalletBalance: wallets._sum.balance || 0,
            activeFeesCount,
            totalInvoices: invoices._count.id || 0,
            paidCount,
            partialCount,
            overdueCount,
            collectionRate
        },
        recentTransactions: recentTx.map(t => ({
            id: t.id,
            reference: t.reference,
            amount: t.amount,
            method: t.method,
            paidAt: t.paidAt,
            studentName: t.student?.user?.name || 'Unknown'
        })),
        methodBreakdown: methodAgg.map(m => ({
            method: m.method,
            total: m._sum.amount || 0,
            count: m._count.id
        }))
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
    const { currencySymbol, invoicePrefix, receiptPrefix, allowPartialPayment, allowOverpayment, autoApplyWallet, showOptionalFees, showItemizedBreakdown, enableTransport, financeModuleToggles } = req.body;

    const settings = await prisma.financeSettings.upsert({
        where: { schoolId },
        update: {
            currencySymbol, invoicePrefix, receiptPrefix, allowPartialPayment, allowOverpayment, autoApplyWallet, showOptionalFees, showItemizedBreakdown, enableTransport,
            ...(financeModuleToggles && { financeModuleToggles })
        },
        create: {
            schoolId, currencySymbol, invoicePrefix, receiptPrefix, allowPartialPayment, allowOverpayment, autoApplyWallet, showOptionalFees, showItemizedBreakdown, enableTransport,
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

    if (!data.name || !data.name.trim()) {
        throw new CustomError.BadRequestError('Fee name is required');
    }
    if (data.amount === undefined || Number(data.amount) < 0) {
        throw new CustomError.BadRequestError('Valid amount is required');
    }

    const fee = await prisma.feeDefinition.create({
        data: {
            schoolId,
            branchId: activeBranchId || undefined,
            name: data.name.trim(),
            code: data.code || undefined,
            type: data.type || 'FEE',
            category: data.category || 'TUITION',
            amount: Number(data.amount),
            quantity: data.quantity ? Number(data.quantity) : null,
            studentType: data.studentType || 'BOTH',
            scope: data.scope || 'WHOLE_SCHOOL',
            classIds: Array.isArray(data.classIds) ? data.classIds : [],
            termScope: data.termScope || 'ANNUAL',
            isCompulsory: data.isCompulsory !== undefined ? Boolean(data.isCompulsory) : true,
            showOnPortal: data.showOnPortal !== undefined ? Boolean(data.showOnPortal) : true,
            allowInstallment: Boolean(data.allowInstallment),
            dueDate: data.dueDate ? new Date(data.dueDate) : null
        }
    });

    res.status(StatusCodes.CREATED).json({ fee, msg: 'Fee created successfully' });
};

const updateFeeDefinition = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;

    const existing = await prisma.feeDefinition.findUnique({ where: { id } });
    if (!existing || existing.schoolId !== schoolId || existing.isDeleted) {
        throw new CustomError.NotFoundError('Fee definition not found');
    }

    const d = req.body;
    const fee = await prisma.feeDefinition.update({
        where: { id },
        data: {
            ...(d.name      !== undefined && { name: d.name.trim() }),
            ...(d.code      !== undefined && { code: d.code }),
            ...(d.type      !== undefined && { type: d.type }),
            ...(d.category  !== undefined && { category: d.category }),
            ...(d.amount    !== undefined && { amount: Number(d.amount) }),
            ...(d.quantity  !== undefined && { quantity: d.quantity ? Number(d.quantity) : null }),
            ...(d.scope     !== undefined && { scope: d.scope }),
            ...(d.classIds  !== undefined && { classIds: Array.isArray(d.classIds) ? d.classIds : [] }),
            ...(d.termScope !== undefined && { termScope: d.termScope }),
            ...(d.isCompulsory !== undefined && { isCompulsory: Boolean(d.isCompulsory) }),
            ...(d.showOnPortal !== undefined && { showOnPortal: Boolean(d.showOnPortal) }),
            ...(d.isActive  !== undefined && { isActive: Boolean(d.isActive) }),
            ...(d.dueDate   !== undefined && { dueDate: d.dueDate ? new Date(d.dueDate) : null }),
        }
    });

    res.status(StatusCodes.OK).json({ fee, msg: 'Fee updated successfully' });
};

const deleteFeeDefinition = async (req, res) => {
    const { id } = req.params;
    const { schoolId, id: userId } = req.user;

    const existing = await prisma.feeDefinition.findUnique({ where: { id } });
    if (!existing || existing.schoolId !== schoolId || existing.isDeleted) {
        throw new CustomError.NotFoundError('Fee definition not found');
    }

    // Soft-delete the fee — preserve invoice history
    await prisma.$transaction([
        prisma.feeDefinition.update({
            where: { id },
            data: { isDeleted: true, deletedAt: new Date(), deletedBy: userId }
        }),
        // Remove dangling student fee assignments for this fee
        prisma.studentFeeAssignment.deleteMany({ where: { feeDefinitionId: id } })
    ]);

    res.status(StatusCodes.OK).json({ msg: 'Fee deleted successfully' });
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

const getFamilyWallet = async (req, res) => {
    const { parentId } = req.params;
    const { schoolId } = req.user;

    const parent = await prisma.parentProfile.findUnique({
        where: { id: parentId },
        include: {
            user: { select: { name: true, email: true } },
            students: {
                where: { isDeleted: false },
                include: {
                    user: { select: { name: true } },
                    StudentWallet: {
                        include: {
                            StudentWalletTransaction: {
                                orderBy: { createdAt: 'desc' },
                                take: 10
                            }
                        }
                    }
                }
            }
        }
    });

    if (!parent) {
        throw new CustomError.NotFoundError('Parent not found');
    }

    const familyWallets = parent.students.map(student => {
        const wallet = student.StudentWallet;
        return {
            studentId: student.id,
            studentName: student.user?.name,
            admissionNo: student.admissionNo,
            balance: wallet ? wallet.balance : 0,
            status: wallet ? wallet.status : 'ACTIVE',
            transactions: wallet ? wallet.StudentWalletTransaction : []
        };
    });

    const totalFamilyBalance = familyWallets.reduce((acc, curr) => acc + curr.balance, 0);

    res.status(StatusCodes.OK).json({
        parentName: parent.user?.name,
        totalFamilyBalance,
        familyWallets
    });
};

// ─── PHASE 10: REPORTS ───────────────────────────────────────────────────────

const getBillsReport = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { term, academicYear, classId, status, from, to, limit = '100', page = '1' } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const where = {
        schoolId, isDeleted: false,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(term && { term }),
        ...(academicYear && { academicYear }),
        ...(status && { status }),
        ...(classId && { student: { classId } }),
        ...(from || to ? { createdAt: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } } : {})
    };

    const [invoices, total, agg] = await Promise.all([
        prisma.financeInvoice.findMany({
            where, skip, take: Number(limit),
            include: {
                student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } },
                items: true
            },
            orderBy: { createdAt: 'desc' }
        }),
        prisma.financeInvoice.count({ where }),
        prisma.financeInvoice.aggregate({ where, _sum: { totalAmount: true, amountPaid: true, balanceDue: true } })
    ]);

    res.status(StatusCodes.OK).json({
        invoices: invoices.map(inv => ({
            id: inv.id,
            invoiceNumber: inv.invoiceNumber,
            status: inv.status,
            term: inv.term,
            academicYear: inv.academicYear,
            totalAmount: inv.totalAmount,
            amountPaid: inv.amountPaid,
            balanceDue: inv.balanceDue,
            createdAt: inv.createdAt,
            studentName: inv.student?.user?.name,
            admissionNo: inv.student?.admissionNo,
            className: inv.student?.classArm?.name,
            items: inv.items.map(i => ({ name: i.label, amount: i.amount, quantity: i.quantity }))
        })),
        total,
        totals: {
            expected: agg._sum.totalAmount || 0,
            collected: agg._sum.amountPaid || 0,
            outstanding: agg._sum.balanceDue || 0
        }
    });
};

const getPaymentsReport = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { method, from, to, term, limit = '100', page = '1' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = {
        schoolId, status: 'SUCCESSFUL',
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(method && { method }),
        ...(from || to ? { paidAt: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } } : {})
    };

    const [transactions, total, byMethod] = await Promise.all([
        prisma.paymentTransaction.findMany({
            where, skip, take: Number(limit),
            include: {
                student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } },
                receipt: { select: { receiptNumber: true } }
            },
            orderBy: { paidAt: 'desc' }
        }),
        prisma.paymentTransaction.count({ where }),
        prisma.paymentTransaction.groupBy({
            by: ['method'], where,
            _sum: { amount: true }, _count: { id: true }
        })
    ]);

    res.status(StatusCodes.OK).json({
        transactions: transactions.map(t => ({
            id: t.id, reference: t.reference, method: t.method,
            amount: t.amount, paidAt: t.paidAt,
            studentName: t.student?.user?.name,
            admissionNo: t.student?.admissionNo,
            className: t.student?.classArm?.name,
            receiptNumber: t.receipt?.receiptNumber
        })),
        total,
        byMethod: byMethod.map(m => ({ method: m.method, total: m._sum.amount || 0, count: m._count.id }))
    });
};

const getItemsReport = async (req, res) => {
    const { schoolId } = req.user;
    const { term, academicYear } = req.query;

    const invoiceWhere = {
        schoolId, isDeleted: false,
        ...(term && { term }),
        ...(academicYear && { academicYear })
    };

    // Fetch all invoice items and aggregate by fee name in JS
    const rawItems = await prisma.financeInvoiceItem.findMany({
        where: { invoice: invoiceWhere },
        select: { label: true, amount: true }
    });

    // Group by feeName
    const grouped = {};
    for (const item of rawItems) {
        const key = item.label || 'Unnamed Fee';
        if (!grouped[key]) grouped[key] = { totalBilled: 0, invoiceCount: 0 };
        grouped[key].totalBilled += Number(item.amount || 0);
        grouped[key].invoiceCount += 1;
    }

    const items = Object.entries(grouped)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.totalBilled - a.totalBilled);

    res.status(StatusCodes.OK).json({ items });
};

const getOutstandingReport = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { term, academicYear, classId } = req.query;

    const where = {
        schoolId, isDeleted: false,
        status: { in: ['OPEN', 'SENT', 'PARTIALLY_PAID'] },
        balanceDue: { gt: 0 },
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(term && { term }),
        ...(academicYear && { academicYear }),
        ...(classId && { student: { classId } })
    };

    const invoices = await prisma.financeInvoice.findMany({
        where,
        include: {
            student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } }
        },
        orderBy: { balanceDue: 'desc' }
    });

    res.status(StatusCodes.OK).json({
        count: invoices.length,
        students: invoices.map(inv => ({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            status: inv.status,
            totalAmount: inv.totalAmount,
            amountPaid: inv.amountPaid,
            balanceDue: inv.balanceDue,
            studentName: inv.student?.user?.name,
            admissionNo: inv.student?.admissionNo,
            className: inv.student?.classArm?.name,
            createdAt: inv.createdAt
        }))
    });
};

const exportReportCsv = async (req, res) => {
    const { type = 'bills', term, academicYear, method, from, to, status } = req.query;
    const { schoolId } = req.user;

    let rows = [];
    let filename = `skooly-${type}-report`;
    if (term) filename += `-${term}`;
    if (academicYear) filename += `-${academicYear.replace('/', '-')}`;
    filename += '.csv';

    if (type === 'bills') {
        const where = { schoolId, isDeleted: false, ...(term && { term }), ...(academicYear && { academicYear }), ...(status && { status }) };
        const invoices = await prisma.financeInvoice.findMany({
            where, take: 5000,
            include: { student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } } },
            orderBy: { createdAt: 'desc' }
        });
        const header = 'Invoice #,Student,Class,Term,Academic Year,Status,Total,Paid,Balance,Date';
        const dataRows = invoices.map(inv =>
            [
                inv.invoiceNumber, inv.student?.user?.name, inv.student?.classArm?.name,
                inv.term, inv.academicYear, inv.status,
                inv.totalAmount, inv.amountPaid, inv.balanceDue,
                inv.createdAt.toISOString().split('T')[0]
            ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
        );
        rows = [header, ...dataRows];
    } else if (type === 'payments') {
        const where = { schoolId, status: 'SUCCESSFUL', ...(method && { method }), ...(from || to ? { paidAt: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } } : {}) };
        const txns = await prisma.paymentTransaction.findMany({
            where, take: 5000,
            include: { student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } }, receipt: { select: { receiptNumber: true } } },
            orderBy: { paidAt: 'desc' }
        });
        const header = 'Reference,Student,Class,Method,Amount,Receipt #,Date';
        const dataRows = txns.map(t =>
            [t.reference, t.student?.user?.name, t.student?.classArm?.name, t.method, t.amount, t.receipt?.receiptNumber, t.paidAt?.toISOString().split('T')[0]]
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
        );
        rows = [header, ...dataRows];
    } else if (type === 'outstanding') {
        const where = { schoolId, isDeleted: false, status: { in: ['OPEN', 'SENT', 'PARTIALLY_PAID'] }, balanceDue: { gt: 0 }, ...(term && { term }), ...(academicYear && { academicYear }) };
        const invoices = await prisma.financeInvoice.findMany({
            where, take: 5000,
            include: { student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } } },
            orderBy: { balanceDue: 'desc' }
        });
        const header = 'Invoice #,Student,Class,Status,Total,Paid,Balance Due,Date';
        const dataRows = invoices.map(inv =>
            [inv.invoiceNumber, inv.student?.user?.name, inv.student?.classArm?.name, inv.status, inv.totalAmount, inv.amountPaid, inv.balanceDue, inv.createdAt.toISOString().split('T')[0]]
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
        );
        rows = [header, ...dataRows];
    }

    const csv = rows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
};

// ─── LEDGER CATEGORIES ────────────────────────────────────────────────────────

const getFinanceCategories = async (req, res) => {
    const { schoolId } = req.user;
    const { type } = req.query; // 'INCOME' or 'EXPENSE'

    const where = { schoolId };
    if (type) where.type = type;

    const categories = await prisma.financeCategory.findMany({
        where,
        orderBy: { name: 'asc' }
    });

    res.status(StatusCodes.OK).json({ categories });
};

const createFinanceCategory = async (req, res) => {
    const { schoolId } = req.user;
    const { name, type } = req.body;

    if (!name || !type) {
        throw new CustomError.BadRequestError('Please provide category name and type');
    }

    const exists = await prisma.financeCategory.findFirst({
        where: { schoolId, name, type }
    });
    if (exists) {
        throw new CustomError.BadRequestError(`Category '${name}' already exists for ${type}`);
    }

    const category = await prisma.financeCategory.create({
        data: { schoolId, name, type }
    });

    res.status(StatusCodes.CREATED).json({ category });
};

const updateFinanceCategory = async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;

    const category = await prisma.financeCategory.findUnique({ where: { id } });
    if (!category) {
        throw new CustomError.NotFoundError('Category not found');
    }

    const updated = await prisma.financeCategory.update({
        where: { id },
        data: { name }
    });

    res.status(StatusCodes.OK).json({ category: updated });
};

const deleteFinanceCategory = async (req, res) => {
    const { id } = req.params;

    const category = await prisma.financeCategory.findUnique({ where: { id } });
    if (!category) {
        throw new CustomError.NotFoundError('Category not found');
    }

    // Don't delete if it has records
    const incomes = await prisma.incomeRecord.count({ where: { categoryId: id } });
    const expenses = await prisma.expenseRecord.count({ where: { categoryId: id } });

    if (incomes > 0 || expenses > 0) {
        throw new CustomError.BadRequestError('Cannot delete category that has existing ledger records');
    }

    await prisma.financeCategory.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Category deleted successfully' });
};

// ─── LEDGER RECORDS (INCOME & EXPENSES) ────────────────────────────────────────

const getLedgerRecords = async (req, res) => {
    const { schoolId } = req.user;
    const { type, from, to, source } = req.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const commonWhere = { schoolId };
    if (Object.keys(dateFilter).length > 0) commonWhere.date = dateFilter;
    if (source) commonWhere.source = source;

    let records = [];

    if (!type || type === 'INCOME') {
        const incomes = await prisma.incomeRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        });
        records.push(...incomes.map(i => ({ ...i, recordType: 'INCOME' })));
    }

    if (!type || type === 'EXPENSE') {
        const expenses = await prisma.expenseRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        });
        records.push(...expenses.map(e => ({ ...e, recordType: 'EXPENSE' })));
    }

    records.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(StatusCodes.OK).json({ records });
};

const createLedgerRecord = async (req, res) => {
    const { schoolId, userId } = req.user;
    const { categoryId, description, amount, date, type } = req.body;

    if (!categoryId || !description || !amount || !date || !type) {
        throw new CustomError.BadRequestError('Please provide all required fields');
    }

    const category = await prisma.financeCategory.findUnique({ where: { id: categoryId } });
    if (!category || category.type !== type || category.schoolId !== schoolId) {
        throw new CustomError.BadRequestError('Invalid category');
    }

    let record;
    if (type === 'INCOME') {
        record = await prisma.incomeRecord.create({
            data: {
                schoolId, categoryId, description,
                amount: Number(amount), date: new Date(date),
                source: 'MANUAL', createdBy: userId
            },
            include: { category: true }
        });
    } else {
        record = await prisma.expenseRecord.create({
            data: {
                schoolId, categoryId, description,
                amount: Number(amount), date: new Date(date),
                source: 'MANUAL', createdBy: userId
            },
            include: { category: true }
        });
    }

    res.status(StatusCodes.CREATED).json({ record: { ...record, recordType: type } });
};

const updateLedgerRecord = async (req, res) => {
    const { schoolId } = req.user;
    const { id, type } = req.params;
    const { categoryId, description, amount, date } = req.body;

    const Model = type === 'INCOME' ? prisma.incomeRecord : prisma.expenseRecord;
    const record = await Model.findUnique({ where: { id } });

    if (!record || record.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Record not found');
    }
    if (record.source === 'AUTO') {
        throw new CustomError.BadRequestError('Cannot edit auto-generated system records');
    }

    if (categoryId) {
        const category = await prisma.financeCategory.findUnique({ where: { id: categoryId } });
        if (!category || category.type !== type) throw new CustomError.BadRequestError('Invalid category');
    }

    const updated = await Model.update({
        where: { id },
        data: {
            categoryId: categoryId || undefined,
            description: description || undefined,
            amount: amount ? Number(amount) : undefined,
            date: date ? new Date(date) : undefined
        },
        include: { category: true }
    });

    res.status(StatusCodes.OK).json({ record: { ...updated, recordType: type } });
};

const deleteLedgerRecord = async (req, res) => {
    const { schoolId } = req.user;
    const { id, type } = req.params;

    const Model = type === 'INCOME' ? prisma.incomeRecord : prisma.expenseRecord;
    const record = await Model.findUnique({ where: { id } });

    if (!record || record.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Record not found');
    }
    if (record.source === 'AUTO') {
        throw new CustomError.BadRequestError('Cannot delete auto-generated system records');
    }

    await Model.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Record deleted successfully' });
};

// ─── PROFIT & LOSS REPORT ──────────────────────────────────────────────────────

const getProfitLossReport = async (req, res) => {
    const { schoolId } = req.user;
    const { from, to } = req.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const commonWhere = { schoolId };
    if (Object.keys(dateFilter).length > 0) commonWhere.date = dateFilter;

    // Fetch aggregated income by category
    const incomeAgg = await prisma.incomeRecord.groupBy({
        by: ['categoryId'],
        where: commonWhere,
        _sum: { amount: true }
    });

    // Fetch aggregated expenses by category
    const expenseAgg = await prisma.expenseRecord.groupBy({
        by: ['categoryId'],
        where: commonWhere,
        _sum: { amount: true }
    });

    // Fetch all categories to map names
    const categories = await prisma.financeCategory.findMany({ where: { schoolId } });
    const catMap = categories.reduce((acc, cat) => {
        acc[cat.id] = cat.name;
        return acc;
    }, {});

    const incomes = incomeAgg.map(i => ({
        categoryId: i.categoryId,
        categoryName: catMap[i.categoryId] || 'Uncategorized',
        amount: i._sum.amount || 0
    }));

    const expenses = expenseAgg.map(e => ({
        categoryId: e.categoryId,
        categoryName: catMap[e.categoryId] || 'Uncategorized',
        amount: e._sum.amount || 0
    }));

    const totalIncome = incomes.reduce((sum, item) => sum + item.amount, 0);
    const totalExpense = expenses.reduce((sum, item) => sum + item.amount, 0);
    const netProfit = totalIncome - totalExpense;

    // Build monthly trend for the last 6 months if no date filter, or based on the range.
    // For simplicity, we'll return the raw data and let frontend group, or do a simple 6-month aggregate here.
    // Since we want dynamic charts, sending raw records for the period is easiest, but that could be large.
    // Let's do a fast 6-month grouping.
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);

    const trendWhere = { schoolId, date: { gte: sixMonthsAgo } };
    
    const [trendIncomes, trendExpenses] = await Promise.all([
        prisma.incomeRecord.findMany({ where: trendWhere, select: { amount: true, date: true } }),
        prisma.expenseRecord.findMany({ where: trendWhere, select: { amount: true, date: true } })
    ]);

    const months = {};
    for (let i = 0; i < 6; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const key = d.toLocaleString('default', { month: 'short', year: 'numeric' });
        months[key] = { month: key, income: 0, expense: 0, sortKey: d.getTime() };
    }

    trendIncomes.forEach(r => {
        const key = new Date(r.date).toLocaleString('default', { month: 'short', year: 'numeric' });
        if (months[key]) months[key].income += r.amount;
    });

    trendExpenses.forEach(r => {
        const key = new Date(r.date).toLocaleString('default', { month: 'short', year: 'numeric' });
        if (months[key]) months[key].expense += r.amount;
    });

    const monthlyTrend = Object.values(months).sort((a, b) => a.sortKey - b.sortKey);

    res.status(StatusCodes.OK).json({
        totalIncome,
        totalExpense,
        netProfit,
        incomes,
        expenses,
        monthlyTrend
    });
};

const exportLedgerCsv = async (req, res) => {
    const { schoolId } = req.user;
    const { type, from, to, source } = req.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const commonWhere = { schoolId };
    if (Object.keys(dateFilter).length > 0) commonWhere.date = dateFilter;
    if (source) commonWhere.source = source;

    let records = [];

    if (!type || type === 'INCOME') {
        const incomes = await prisma.incomeRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        });
        records.push(...incomes.map(i => ({ ...i, recordType: 'INCOME' })));
    }

    if (!type || type === 'EXPENSE') {
        const expenses = await prisma.expenseRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        });
        records.push(...expenses.map(e => ({ ...e, recordType: 'EXPENSE' })));
    }

    records.sort((a, b) => new Date(b.date) - new Date(a.date));

    const header = ['Date', 'Type', 'Category', 'Description', 'Source', 'Amount'];
    const dataRows = records.map(r => [
        new Date(r.date).toISOString().split('T')[0],
        r.recordType,
        r.category?.name || 'Uncategorized',
        r.description,
        r.source,
        r.amount
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));

    const csv = [header.join(','), ...dataRows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="ledger_export.csv"');
    res.status(200).send(csv);
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
    getFamilyWallet,
    fundWallet,
    // Phase 10
    getBillsReport,
    getPaymentsReport,
    getItemsReport,
    getOutstandingReport,
    exportReportCsv,
    // Ledger Categories
    getFinanceCategories,
    createFinanceCategory,
    updateFinanceCategory,
    deleteFinanceCategory,
    // Ledger Records
    getLedgerRecords,
    createLedgerRecord,
    updateLedgerRecord,
    deleteLedgerRecord,
    // P&L
    getProfitLossReport,
    exportLedgerCsv
};
