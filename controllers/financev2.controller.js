const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

const getFinanceDashboard = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    let { term, academicYear, paymentMethod, lastViewed } = req.query;

    const schoolSettings = await prisma.schoolSettings.findFirst({
        where: { schoolId }
    });

    const isExplicitFilter = !!(term || academicYear);

    if (!term) term = schoolSettings?.currentTerm || null;
    if (!academicYear) academicYear = schoolSettings?.currentYear || null;

    // Resolve dates for Income/Expense/Payroll
    let startDate = null;
    let endDate = null;

    if (term && academicYear) {
        const termNameMap = {
            'FIRST_TERM': 'First Term',
            'SECOND_TERM': 'Second Term',
            'THIRD_TERM': 'Third Term'
        };
        const mappedTermName = termNameMap[term] || term;

        const session = await prisma.academicSession.findFirst({
            where: { schoolId, name: academicYear }
        });

        if (session) {
            const academicTerm = await prisma.academicTerm.findFirst({
                where: { schoolId, sessionId: session.id, name: mappedTermName }
            });
            if (academicTerm && academicTerm.startDate && academicTerm.endDate) {
                startDate = academicTerm.startDate;
                endDate = academicTerm.endDate;
            }
        }
    }

    const termWhere = {
        schoolId,
        isDeleted: false,
        ...(term && { term }),
        ...(academicYear && { academicYear })
    };

    const globalWhere = {
        schoolId,
        isDeleted: false,
        // If explicit filter is passed, filter outstanding balances as well
        ...(isExplicitFilter && term && { term }),
        ...(isExplicitFilter && academicYear && { academicYear })
    };

    const transactionWhere = {
        schoolId,
        status: 'SUCCESSFUL',
        ...(startDate && endDate && { paidAt: { gte: startDate, lte: endDate } }),
        ...(paymentMethod && { method: paymentMethod })
    };

    const [
        termInvoices, globalInvoices, wallets, familyWallets, activeFeesCount, 
        paidCount, partialCount, overdueCount, recentTx, methodAgg,
        incomeRecs, expenseRecs, payrollRuns, receiptSummary
    ] = await Promise.all([
        prisma.financeInvoice.aggregate({
            where: termWhere,
            _sum: { totalAmount: true, amountPaid: true },
            _count: { id: true }
        }),
        prisma.financeInvoice.aggregate({
            where: globalWhere,
            _sum: { balanceDue: true }
        }),
        prisma.studentWallet.aggregate({
            where: { 
                schoolId, 
                // Cannot easily filter wallet balances by term because it's a running total, so just global
            },
            _sum: { balance: true }
        }),
        prisma.familyWallet.aggregate({
            where: { schoolId },
            _sum: { balance: true }
        }),
        prisma.feeDefinition.count({ where: { schoolId, isActive: true, isDeleted: false } }),
        prisma.financeInvoice.count({ where: { ...termWhere, status: 'PAID' } }),
        prisma.financeInvoice.count({ where: { ...termWhere, status: 'PARTIALLY_PAID' } }),
        prisma.financeInvoice.count({ where: { ...termWhere, status: { in: ['OPEN', 'DRAFT', 'SENT'] }, balanceDue: { gt: 0 } } }),
        prisma.paymentTransaction.findMany({
            where: transactionWhere,
            include: { student: { include: { user: { select: { name: true } } } } },
            orderBy: { paidAt: 'desc' },
            take: 8
        }),
        prisma.paymentTransaction.groupBy({
            by: ['method'],
            where: { schoolId, status: 'SUCCESSFUL', ...(startDate && endDate && { paidAt: { gte: startDate, lte: endDate } }) },
            _sum: { amount: true },
            _count: { id: true }
        }),
        prisma.incomeRecord.aggregate({
            where: { schoolId, ...(startDate && endDate && { date: { gte: startDate, lte: endDate } }) },
            _sum: { amount: true }
        }),
        prisma.expenseRecord.aggregate({
            where: { schoolId, ...(startDate && endDate && { date: { gte: startDate, lte: endDate } }) },
            _sum: { amount: true }
        }),
        prisma.payrollRun.aggregate({
            where: { schoolId, status: 'confirmed', ...(startDate && endDate && { runDate: { gte: startDate, lte: endDate } }) },
            _sum: { totalNet: true }
        }),
        prisma.paymentTransaction.aggregate({
            where: transactionWhere,
            _sum: { amount: true },
            _count: { id: true }
        })
    ]);

    let newTransactionsCount = 0;
    if (lastViewed) {
        newTransactionsCount = await prisma.paymentTransaction.count({
            where: {
                schoolId,
                status: 'SUCCESSFUL',
                paidAt: { gt: new Date(lastViewed) }
            }
        });
    }

    const expectedFees = termInvoices._sum.totalAmount || 0;
    const collectedFees = receiptSummary._sum.amount || termInvoices._sum.amountPaid || 0;
    const collectionRate = expectedFees > 0 ? Math.round((collectedFees / expectedFees) * 100) : 0;

    res.status(StatusCodes.OK).json({ termWhere, stats: {
            expectedFees,
            collectedFees,
            outstandingBalance: globalInvoices._sum.balanceDue || 0,
            totalWalletBalance: (wallets._sum.balance || 0) + (familyWallets._sum.balance || 0),
            activeFeesCount,
            totalInvoices: termInvoices._count.id || 0,
            paidCount,
            partialCount,
            overdueCount,
            collectionRate,
            totalIncome: incomeRecs._sum.amount || 0,
            totalExpense: expenseRecs._sum.amount || 0,
            totalPayroll: payrollRuns._sum.totalNet || 0,
            receiptCount: receiptSummary._count.id || 0,
            receiptTotal: receiptSummary._sum.amount || 0,
            newTransactionsCount
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

    // Fetch school settings and academic sessions/terms for context
    const [schoolSettings, sessions, terms] = await Promise.all([
        prisma.schoolSettings.findFirst({ where: { schoolId } }),
        prisma.academicSession.findMany({ where: { schoolId }, orderBy: { createdAt: 'desc' } }),
        prisma.academicTerm.findMany({ where: { schoolId }, orderBy: { createdAt: 'asc' } })
    ]);

    // Ensure financeModuleToggles has structured defaults if empty or partial
    const rawToggles = (settings.financeModuleToggles && typeof settings.financeModuleToggles === 'object')
        ? settings.financeModuleToggles
        : {};

    const mergedSettings = {
        ...settings,
        currentTerm: schoolSettings?.currentTerm || 'First Term',
        currentYear: schoolSettings?.currentYear || '',
        schoolName: schoolSettings?.schoolName || '',
        logoUrl: schoolSettings?.logoUrl || '',
        sessions: sessions || [],
        terms: terms || [],
        financeModuleToggles: {
            display: {
                showItemizedBreakdown: settings.showItemizedBreakdown ?? true,
                showOptionalFees: settings.showOptionalFees ?? true,
                showSchoolLogo: rawToggles.display?.showSchoolLogo ?? true,
                showBankDetails: rawToggles.display?.showBankDetails ?? true,
                showDueDate: rawToggles.display?.showDueDate ?? true,
                showParentInfo: rawToggles.display?.showParentInfo ?? true,
                showPaymentInstructions: rawToggles.display?.showPaymentInstructions ?? true,
                showTaxColumn: rawToggles.display?.showTaxColumn ?? false,
                showDiscountColumn: rawToggles.display?.showDiscountColumn ?? true,
                showPreviousBalance: rawToggles.display?.showPreviousBalance ?? true,
                showWatermark: rawToggles.display?.showWatermark ?? true,
                showQrCode: rawToggles.display?.showQrCode ?? true,
                showSignatureLine: rawToggles.display?.showSignatureLine ?? true,
                headerLayoutMode: rawToggles.display?.headerLayoutMode || 'CLASSIC_LEFT',
                instructionsText: rawToggles.display?.instructionsText || 'Please quote the Student Admission Number or Invoice Number on all bank transfer deposits.',
                footerNote: rawToggles.display?.footerNote || 'Thank you for your prompt payment. In case of discrepancies, kindly contact the Bursary Department.',
                ...(rawToggles.display || {})
            },
            termLock: {
                locked: rawToggles.termLock?.locked ?? false,
                activeTerm: rawToggles.termLock?.activeTerm || schoolSettings?.currentTerm || 'First Term',
                activeSession: rawToggles.termLock?.activeSession || schoolSettings?.currentYear || '',
                allowStaffOverride: rawToggles.termLock?.allowStaffOverride ?? false,
                ...(rawToggles.termLock || {})
            },
            rolePermissions: rawToggles.rolePermissions || {
                CASHIER: {
                    canRecordPayments: true,
                    canPrintReceipts: true,
                    canViewInvoices: true,
                    canCreateInvoices: false,
                    canEditInvoices: false,
                    canDeleteInvoices: false,
                    canApproveTransfers: false,
                    canApplyDiscounts: false,
                    canViewPayroll: false,
                    canRunPayroll: false,
                    canViewReports: false,
                    canManageSettings: false
                },
                ACCOUNTANT: {
                    canRecordPayments: true,
                    canPrintReceipts: true,
                    canViewInvoices: true,
                    canCreateInvoices: true,
                    canEditInvoices: true,
                    canDeleteInvoices: false,
                    canApproveTransfers: true,
                    canApplyDiscounts: true,
                    canViewPayroll: true,
                    canRunPayroll: false,
                    canViewReports: true,
                    canManageSettings: false
                },
                BURSAR: {
                    canRecordPayments: true,
                    canPrintReceipts: true,
                    canViewInvoices: true,
                    canCreateInvoices: true,
                    canEditInvoices: true,
                    canDeleteInvoices: true,
                    canApproveTransfers: true,
                    canApplyDiscounts: true,
                    canViewPayroll: true,
                    canRunPayroll: true,
                    canViewReports: true,
                    canManageSettings: true
                },
                AUDITOR: {
                    canRecordPayments: false,
                    canPrintReceipts: true,
                    canViewInvoices: true,
                    canCreateInvoices: false,
                    canEditInvoices: false,
                    canDeleteInvoices: false,
                    canApproveTransfers: false,
                    canApplyDiscounts: false,
                    canViewPayroll: true,
                    canRunPayroll: false,
                    canViewReports: true,
                    canManageSettings: false
                }
            }
        }
    };

    res.status(StatusCodes.OK).json({ settings: mergedSettings });
};

const updateFinanceSettings = async (req, res) => {
    const { schoolId } = req.user;
    
    // Extract updateable fields safely
    const { 
        currencySymbol, 
        invoicePrefix, 
        receiptPrefix, 
        allowPartialPayment, 
        allowOverpayment, 
        autoApplyWallet, 
        showOptionalFees, 
        showItemizedBreakdown, 
        enableTransport, 
        financeBranding,
        financeModuleToggles,
        currentTerm,
        currentYear
    } = req.body;

    const itemized = financeModuleToggles?.display?.showItemizedBreakdown !== undefined 
        ? financeModuleToggles.display.showItemizedBreakdown 
        : showItemizedBreakdown;

    const optionalFees = financeModuleToggles?.display?.showOptionalFees !== undefined
        ? financeModuleToggles.display.showOptionalFees
        : showOptionalFees;

    const settings = await prisma.financeSettings.upsert({
        where: { schoolId },
        update: {
            ...(currencySymbol !== undefined && { currencySymbol }),
            ...(invoicePrefix !== undefined && { invoicePrefix }),
            ...(receiptPrefix !== undefined && { receiptPrefix }),
            ...(allowPartialPayment !== undefined && { allowPartialPayment }),
            ...(allowOverpayment !== undefined && { allowOverpayment }),
            ...(autoApplyWallet !== undefined && { autoApplyWallet }),
            ...(optionalFees !== undefined && { showOptionalFees: optionalFees }),
            ...(itemized !== undefined && { showItemizedBreakdown: itemized }),
            ...(enableTransport !== undefined && { enableTransport }),
            ...(financeBranding !== undefined && { financeBranding }),
            ...(financeModuleToggles !== undefined && { financeModuleToggles })
        },
        create: {
            schoolId, 
            currencySymbol: currencySymbol || '₦', 
            invoicePrefix: invoicePrefix || 'INV-', 
            receiptPrefix: receiptPrefix || 'REC-', 
            allowPartialPayment: allowPartialPayment ?? true, 
            allowOverpayment: allowOverpayment ?? false, 
            autoApplyWallet: autoApplyWallet ?? false, 
            showOptionalFees: optionalFees ?? true, 
            showItemizedBreakdown: itemized ?? true, 
            enableTransport: enableTransport ?? false,
            financeBranding: financeBranding || null,
            financeModuleToggles: financeModuleToggles || null
        }
    });

    // If term lock or currentTerm/currentYear was updated, sync with school settings
    const activeTermToSync = financeModuleToggles?.termLock?.activeTerm || currentTerm;
    const activeYearToSync = financeModuleToggles?.termLock?.activeSession || currentYear;

    if (activeTermToSync || activeYearToSync) {
        await prisma.schoolSettings.updateMany({
            where: { schoolId },
            data: {
                ...(activeTermToSync && { currentTerm: activeTermToSync }),
                ...(activeYearToSync && { currentYear: activeYearToSync })
            }
        });
    }

    res.status(StatusCodes.OK).json({ settings, msg: 'Finance settings updated successfully' });
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
            termScope: data.termScope ? data.termScope.toUpperCase().replace(/\s+/g, '_') : 'ANNUAL',
            isCompulsory: data.isCompulsory !== undefined ? Boolean(data.isCompulsory) : true,
            showOnPortal: data.showOnPortal !== undefined ? Boolean(data.showOnPortal) : true,
            allowInstallment: data.allowInstallment !== undefined ? Boolean(data.allowInstallment) : false,
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            bankAccountId: data.bankAccountId || null,
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
            ...(d.termScope !== undefined && { termScope: d.termScope.toUpperCase().replace(/\s+/g, '_') }),
            ...(d.isCompulsory !== undefined && { isCompulsory: Boolean(d.isCompulsory) }),
            ...(d.showOnPortal !== undefined && { showOnPortal: Boolean(d.showOnPortal) }),
            ...(d.isActive  !== undefined && { isActive: Boolean(d.isActive) }),
            ...(d.dueDate   !== undefined && { dueDate: d.dueDate ? new Date(d.dueDate) : null }),
            ...(d.bankAccountId !== undefined && { bankAccountId: d.bankAccountId || null }),
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

// ==========================================
// FEE RULES (DISCOUNTS / SURCHARGES)
// ==========================================

const getFeeRules = async (req, res) => {
    const { schoolId } = req.user;
    const rules = await prisma.feeRule.findMany({
        where: { schoolId },
        include: { targetFee: true },
        orderBy: { createdAt: 'desc' }
    });
    res.status(StatusCodes.OK).json({ rules });
};

const createFeeRule = async (req, res) => {
    const { schoolId } = req.user;
    const { name, targetFeeId, conditionType, conditionValue, actionType, actionValue, isActive } = req.body;

    if (!name || !conditionType || !actionType || actionValue === undefined) {
        throw new CustomError.BadRequestError('Missing required rule fields');
    }

    const rule = await prisma.feeRule.create({
        data: {
            schoolId,
            name,
            targetFeeId: targetFeeId || null,
            conditionType,
            conditionValue: conditionValue || null,
            actionType,
            actionValue: Number(actionValue),
            isActive: isActive !== undefined ? Boolean(isActive) : true
        }
    });

    res.status(StatusCodes.CREATED).json({ rule, msg: 'Rule created successfully' });
};

const updateFeeRule = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;
    
    const existing = await prisma.feeRule.findUnique({ where: { id } });
    if (!existing || existing.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Rule not found');
    }

    const d = req.body;
    const rule = await prisma.feeRule.update({
        where: { id },
        data: {
            ...(d.name !== undefined && { name: d.name }),
            ...(d.targetFeeId !== undefined && { targetFeeId: d.targetFeeId || null }),
            ...(d.conditionType !== undefined && { conditionType: d.conditionType }),
            ...(d.conditionValue !== undefined && { conditionValue: d.conditionValue || null }),
            ...(d.actionType !== undefined && { actionType: d.actionType }),
            ...(d.actionValue !== undefined && { actionValue: Number(d.actionValue) }),
            ...(d.isActive !== undefined && { isActive: Boolean(d.isActive) })
        }
    });

    res.status(StatusCodes.OK).json({ rule, msg: 'Rule updated successfully' });
};

const deleteFeeRule = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;

    const existing = await prisma.feeRule.findUnique({ where: { id } });
    if (!existing || existing.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Rule not found');
    }

    await prisma.feeRule.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Rule deleted successfully' });
};

// ==========================================
// WALLET MANAGEMENT
// ==========================================

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
    const { studentId, parentId, amount, type, description } = req.body;
    const { schoolId } = req.user;

    if ((!studentId && !parentId) || !amount || amount <= 0) {
        throw new CustomError.BadRequestError('Valid studentId or parentId and amount > 0 required');
    }

    if (studentId) {
        let walletCheck = await prisma.studentWallet.findUnique({ where: { studentId } });
        if (!walletCheck) {
            const student = await prisma.studentProfile.findUnique({ where: { id: studentId } });
            if (!student || student.schoolId !== schoolId) {
                throw new CustomError.NotFoundError('Student not found');
            }
            walletCheck = await prisma.studentWallet.create({
                data: { schoolId, studentId, branchId: student.branchId }
            });
        }

        const newTransaction = await prisma.$transaction(async (tx) => {
            const updatedWallet = await tx.studentWallet.update({
                where: { studentId },
                data: { balance: { increment: Number(amount) } }
            });

            if (updatedWallet.balance < 0) {
                throw new CustomError.BadRequestError("Wallet balance cannot fall below zero");
            }

            const balanceAfter = updatedWallet.balance;
            const balanceBefore = balanceAfter - Number(amount);

            return await tx.studentWalletTransaction.create({
                data: {
                    walletId: updatedWallet.id,
                    schoolId,
                    branchId: updatedWallet.branchId,
                    type: type || 'DEPOSIT',
                    amount: Number(amount),
                    balanceBefore,
                    balanceAfter,
                    reference: `SWT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                    description: description || 'Wallet Funding'
                }
            });
        });

        res.status(StatusCodes.OK).json({ transaction: newTransaction, msg: 'Student wallet funded securely' });
        return;
    }

    if (parentId) {
        let walletCheck = await prisma.familyWallet.findUnique({ where: { parentId } });
        if (!walletCheck) {
            const parent = await prisma.parentProfile.findUnique({ where: { id: parentId } });
            if (!parent || parent.schoolId !== schoolId) {
                throw new CustomError.NotFoundError('Parent not found');
            }
            walletCheck = await prisma.familyWallet.create({
                data: { schoolId, parentId }
            });
        }

        const newTransaction = await prisma.$transaction(async (tx) => {
            const updatedWallet = await tx.familyWallet.update({
                where: { parentId },
                data: { balance: { increment: Number(amount) } }
            });

            if (updatedWallet.balance < 0) {
                throw new CustomError.BadRequestError("Wallet balance cannot fall below zero");
            }

            const balanceAfter = updatedWallet.balance;
            const balanceBefore = balanceAfter - Number(amount);

            return await tx.familyWalletTransaction.create({
                data: {
                    walletId: updatedWallet.id,
                    schoolId,
                    type: type || 'DEPOSIT',
                    amount: Number(amount),
                    balanceBefore,
                    balanceAfter,
                    reference: `FWT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                    description: description || 'Family Wallet Funding'
                }
            });
        });

        res.status(StatusCodes.OK).json({ transaction: newTransaction, msg: 'Family wallet funded securely' });
        return;
    }
};

// Merges the family-level ledger with every child's wallet ledger so a deposit made
// for one child also shows up on the family's combined ledger, tagged with which
// account (family or a specific child) it happened on.
const mergeFamilyLedger = (familyWallet, individualWallets) => {
    return [
        ...familyWallet.transactions.map(t => ({ ...t, account: 'FAMILY', studentName: null, admissionNo: null })),
        ...individualWallets.flatMap(iw => iw.transactions.map(t => ({
            ...t, account: 'STUDENT', studentName: iw.studentName, admissionNo: iw.admissionNo
        })))
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
     .slice(0, 30);
};

const getFamilyWallet = async (req, res) => {
    const { parentId } = req.params;
    const { schoolId } = req.user;

    const parent = await prisma.parentProfile.findUnique({
        where: { id: parentId },
        include: {
            user: { select: { name: true, email: true } },
            FamilyWallet: {
                include: {
                    transactions: { orderBy: { createdAt: 'desc' }, take: 20 }
                }
            },
            students: {
                where: { isDeleted: false },
                include: {
                    user: { select: { name: true } },
                    StudentWallet: {
                        include: {
                            transactions: {
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

    let familyWallet = parent.FamilyWallet;
    if (!familyWallet) {
        familyWallet = await prisma.familyWallet.create({
            data: { schoolId, parentId }
        });
        // We will just attach empty to response to avoid refetch
        familyWallet.transactions = [];
    }

    const individualWallets = parent.students.map(student => {
        const wallet = student.StudentWallet;
        return {
            studentId: student.id,
            studentName: student.user?.name,
            admissionNo: student.admissionNo,
            balance: wallet ? wallet.balance : 0,
            status: wallet ? wallet.status : 'ACTIVE',
            transactions: wallet ? wallet.transactions : []
        };
    });

    const totalIndividualBalance = individualWallets.reduce((acc, curr) => acc + curr.balance, 0);
    const totalFamilyBalance = familyWallet.balance + totalIndividualBalance;

    res.status(StatusCodes.OK).json({
        parentName: parent.user?.name,
        familyWalletBalance: familyWallet.balance,
        totalFamilyBalance,
        familyWallet: { ...familyWallet, transactions: mergeFamilyLedger(familyWallet, individualWallets) },
        individualWallets
    });
};

// ─── PHASE 10: REPORTS ───────────────────────────────────────────────────────

// ─── PHASE 10 & 14: GENERAL FINANCIAL REPORTS ────────────────────────────────────────

const getBillsReport = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { term, academicYear, classId, status, from, to, month, year, search, sortBy = 'date', sortOrder = 'desc', limit = '100', page = '1' } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    let dateFilter = {};
    if (from || to) {
        dateFilter = {
            ...(from && { gte: new Date(from) }),
            ...(to && { lte: new Date(to) })
        };
    } else if (month && year) {
        const m = parseInt(month, 10);
        const y = parseInt(year, 10);
        const start = new Date(y, m - 1, 1);
        const end = new Date(y, m, 0, 23, 59, 59, 999);
        dateFilter = { gte: start, lte: end };
    } else if (year) {
        const y = parseInt(year, 10);
        const start = new Date(y, 0, 1);
        const end = new Date(y, 11, 31, 23, 59, 59, 999);
        dateFilter = { gte: start, lte: end };
    }

    const where = {
        schoolId, isDeleted: false,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(term && { term }),
        ...(academicYear && { academicYear }),
        ...(status && status !== 'ALL' && { status }),
        ...(classId && { student: { classId } }),
        ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter })
    };

    let invoices = await prisma.financeInvoice.findMany({
        where,
        include: {
            student: { include: { user: { select: { name: true, email: true } }, classArm: { select: { name: true } } } },
            items: true
        },
        orderBy: { createdAt: 'desc' }
    });

    let mapped = invoices.map(inv => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        term: inv.term,
        academicYear: inv.academicYear,
        totalAmount: inv.totalAmount,
        amountPaid: inv.amountPaid,
        balanceDue: inv.balanceDue,
        createdAt: inv.createdAt,
        studentName: inv.student?.user?.name || 'Unknown Student',
        admissionNo: inv.student?.admissionNo || '—',
        className: inv.student?.classArm?.name || '—',
        items: inv.items.map(i => ({ name: i.label, amount: i.amount, quantity: i.quantity }))
    }));

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        mapped = mapped.filter(inv =>
            inv.invoiceNumber.toLowerCase().includes(q) ||
            inv.studentName.toLowerCase().includes(q) ||
            inv.admissionNo.toLowerCase().includes(q) ||
            inv.className.toLowerCase().includes(q) ||
            inv.status.toLowerCase().includes(q)
        );
    }

    mapped.sort((a, b) => {
        if (sortBy === 'amount' || sortBy === 'total') return sortOrder === 'asc' ? a.totalAmount - b.totalAmount : b.totalAmount - a.totalAmount;
        if (sortBy === 'paid') return sortOrder === 'asc' ? a.amountPaid - b.amountPaid : b.amountPaid - a.amountPaid;
        if (sortBy === 'balance') return sortOrder === 'asc' ? a.balanceDue - b.balanceDue : b.balanceDue - a.balanceDue;
        if (sortBy === 'student' || sortBy === 'name') return sortOrder === 'asc' ? a.studentName.localeCompare(b.studentName) : b.studentName.localeCompare(a.studentName);
        if (sortBy === 'class') return sortOrder === 'asc' ? a.className.localeCompare(b.className) : b.className.localeCompare(a.className);
        const timeA = new Date(a.createdAt).getTime();
        const timeB = new Date(b.createdAt).getTime();
        return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });

    const totalExpected = mapped.reduce((s, i) => s + (i.totalAmount || 0), 0);
    const totalCollected = mapped.reduce((s, i) => s + (i.amountPaid || 0), 0);
    const totalOutstanding = mapped.reduce((s, i) => s + (i.balanceDue || 0), 0);

    const paginated = mapped.slice(skip, skip + Number(limit));

    res.status(StatusCodes.OK).json({
        invoices: paginated,
        total: mapped.length,
        totals: {
            expected: totalExpected,
            collected: totalCollected,
            outstanding: totalOutstanding
        }
    });
};

const getPaymentsReport = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { method, from, to, month, year, search, sortBy = 'date', sortOrder = 'desc', limit = '100', page = '1' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    let dateFilter = {};
    if (from || to) {
        dateFilter = {
            ...(from && { gte: new Date(from) }),
            ...(to && { lte: new Date(to) })
        };
    } else if (month && year) {
        const m = parseInt(month, 10);
        const y = parseInt(year, 10);
        const start = new Date(y, m - 1, 1);
        const end = new Date(y, m, 0, 23, 59, 59, 999);
        dateFilter = { gte: start, lte: end };
    } else if (year) {
        const y = parseInt(year, 10);
        const start = new Date(y, 0, 1);
        const end = new Date(y, 11, 31, 23, 59, 59, 999);
        dateFilter = { gte: start, lte: end };
    }

    const where = {
        schoolId, status: 'SUCCESSFUL',
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(method && method !== 'ALL' && { method }),
        ...(Object.keys(dateFilter).length > 0 && { paidAt: dateFilter })
    };

    const transactions = await prisma.paymentTransaction.findMany({
        where,
        include: {
            student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } },
            receipt: { select: { receiptNumber: true } }
        },
        orderBy: { paidAt: 'desc' }
    });

    let mapped = transactions.map(t => ({
        id: t.id,
        reference: t.reference,
        method: t.method,
        amount: t.amount,
        paidAt: t.paidAt,
        studentName: t.student?.user?.name || 'Student',
        admissionNo: t.student?.admissionNo || '—',
        className: t.student?.classArm?.name || '—',
        receiptNumber: t.receipt?.receiptNumber || '—'
    }));

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        mapped = mapped.filter(t =>
            t.reference.toLowerCase().includes(q) ||
            t.studentName.toLowerCase().includes(q) ||
            t.admissionNo.toLowerCase().includes(q) ||
            t.className.toLowerCase().includes(q) ||
            t.method.toLowerCase().includes(q) ||
            t.receiptNumber.toLowerCase().includes(q)
        );
    }

    mapped.sort((a, b) => {
        if (sortBy === 'amount') return sortOrder === 'asc' ? a.amount - b.amount : b.amount - a.amount;
        if (sortBy === 'student' || sortBy === 'name') return sortOrder === 'asc' ? a.studentName.localeCompare(b.studentName) : b.studentName.localeCompare(a.studentName);
        if (sortBy === 'method') return sortOrder === 'asc' ? a.method.localeCompare(b.method) : b.method.localeCompare(a.method);
        const timeA = new Date(a.paidAt).getTime();
        const timeB = new Date(b.paidAt).getTime();
        return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });

    // Group by method summary
    const byMethodMap = {};
    for (const t of mapped) {
        if (!byMethodMap[t.method]) byMethodMap[t.method] = { method: t.method, total: 0, count: 0 };
        byMethodMap[t.method].total += Number(t.amount || 0);
        byMethodMap[t.method].count += 1;
    }

    const paginated = mapped.slice(skip, skip + Number(limit));

    res.status(StatusCodes.OK).json({
        transactions: paginated,
        total: mapped.length,
        totalAmount: mapped.reduce((s, t) => s + (t.amount || 0), 0),
        byMethod: Object.values(byMethodMap)
    });
};

const getItemsReport = async (req, res) => {
    const { schoolId } = req.user;
    const { term, academicYear, search } = req.query;

    const invoiceWhere = {
        schoolId, isDeleted: false,
        ...(term && { term }),
        ...(academicYear && { academicYear })
    };

    const rawItems = await prisma.financeInvoiceItem.findMany({
        where: { invoice: invoiceWhere },
        select: { label: true, amount: true, quantity: true }
    });

    const grouped = {};
    for (const item of rawItems) {
        const key = item.label || 'General Fee';
        if (!grouped[key]) grouped[key] = { totalBilled: 0, invoiceCount: 0, totalUnits: 0 };
        grouped[key].totalBilled += Number(item.amount || 0);
        grouped[key].invoiceCount += 1;
        grouped[key].totalUnits += Number(item.quantity || 1);
    }

    let items = Object.entries(grouped)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.totalBilled - a.totalBilled);

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        items = items.filter(i => i.name.toLowerCase().includes(q));
    }

    res.status(StatusCodes.OK).json({
        items,
        totalVolume: items.reduce((s, i) => s + i.totalBilled, 0),
        totalCount: items.reduce((s, i) => s + i.invoiceCount, 0)
    });
};

const getOutstandingReport = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { term, academicYear, classId, search, sortBy = 'balance', sortOrder = 'desc' } = req.query;

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
            student: {
                include: {
                    user: { select: { name: true, email: true } },
                    classArm: { select: { name: true } },
                    parent: { include: { user: { select: { name: true, email: true } } } }
                }
            }
        },
        orderBy: { balanceDue: 'desc' }
    });

    let mapped = invoices.map(inv => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        totalAmount: inv.totalAmount,
        amountPaid: inv.amountPaid,
        balanceDue: inv.balanceDue,
        studentName: inv.student?.user?.name || 'Student',
        admissionNo: inv.student?.admissionNo || '—',
        className: inv.student?.classArm?.name || '—',
        parentName: inv.student?.parent?.user?.name || '—',
        parentPhone: inv.student?.parent?.phone || inv.student?.phone || '—',
        parentEmail: inv.student?.parent?.user?.email || inv.student?.user?.email || '—',
        createdAt: inv.createdAt
    }));

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        mapped = mapped.filter(s =>
            s.studentName.toLowerCase().includes(q) ||
            s.admissionNo.toLowerCase().includes(q) ||
            s.className.toLowerCase().includes(q) ||
            s.invoiceNumber.toLowerCase().includes(q) ||
            s.parentName.toLowerCase().includes(q) ||
            s.parentPhone.toLowerCase().includes(q)
        );
    }

    mapped.sort((a, b) => {
        if (sortBy === 'balance') return sortOrder === 'asc' ? a.balanceDue - b.balanceDue : b.balanceDue - a.balanceDue;
        if (sortBy === 'expected') return sortOrder === 'asc' ? a.totalAmount - b.totalAmount : b.totalAmount - a.totalAmount;
        if (sortBy === 'paid') return sortOrder === 'asc' ? a.amountPaid - b.amountPaid : b.amountPaid - a.amountPaid;
        if (sortBy === 'name') return sortOrder === 'asc' ? a.studentName.localeCompare(b.studentName) : b.studentName.localeCompare(a.studentName);
        if (sortBy === 'class') return sortOrder === 'asc' ? a.className.localeCompare(b.className) : b.className.localeCompare(a.className);
        return 0;
    });

    const totalOutstanding = mapped.reduce((s, r) => s + (r.balanceDue || 0), 0);

    res.status(StatusCodes.OK).json({
        count: mapped.length,
        totalOutstanding,
        students: mapped
    });
};

// --- EXECUTIVE SUMMARY REPORT ---
const getExecutiveReportSummary = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { term, academicYear, month, year, from, to } = req.query;

    let dateFilter = {};
    if (from || to) {
        dateFilter = {
            ...(from && { gte: new Date(from) }),
            ...(to && { lte: new Date(to) })
        };
    } else if (month && year) {
        const m = parseInt(month, 10);
        const y = parseInt(year, 10);
        const start = new Date(y, m - 1, 1);
        const end = new Date(y, m, 0, 23, 59, 59, 999);
        dateFilter = { gte: start, lte: end };
    } else if (year) {
        const y = parseInt(year, 10);
        const start = new Date(y, 0, 1);
        const end = new Date(y, 11, 31, 23, 59, 59, 999);
        dateFilter = { gte: start, lte: end };
    }

    const hasDateFilter = Object.keys(dateFilter).length > 0;

    const invoiceWhere = {
        schoolId, isDeleted: false,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(term && { term }),
        ...(academicYear && { academicYear }),
        ...(hasDateFilter && { createdAt: dateFilter })
    };

    const paymentWhere = {
        schoolId, status: 'SUCCESSFUL',
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(hasDateFilter && { paidAt: dateFilter })
    };

    const ledgerWhere = {
        schoolId,
        ...(hasDateFilter && { date: dateFilter })
    };

    const payrollWhere = {
        schoolId,
        ...(month && { month: parseInt(month, 10) }),
        ...(year && { year: parseInt(year, 10) }),
        ...(hasDateFilter && { runDate: dateFilter })
    };

    const [
        invoiceAgg,
        feePaymentAgg,
        incomeAgg,
        expenseAgg,
        payrollAgg,
        feePaymentByMethod,
        incomeByCategory,
        expenseByCategory,
        debtorsCount
    ] = await Promise.all([
        prisma.financeInvoice.aggregate({
            where: invoiceWhere,
            _sum: { totalAmount: true, amountPaid: true, balanceDue: true },
            _count: { id: true }
        }),
        prisma.paymentTransaction.aggregate({
            where: paymentWhere,
            _sum: { amount: true },
            _count: { id: true }
        }),
        prisma.incomeRecord.aggregate({
            where: ledgerWhere,
            _sum: { amount: true },
            _count: { id: true }
        }),
        prisma.expenseRecord.aggregate({
            where: ledgerWhere,
            _sum: { amount: true },
            _count: { id: true }
        }),
        prisma.payrollRun.aggregate({
            where: payrollWhere,
            _sum: { totalGross: true, totalDeductions: true, totalNet: true },
            _count: { id: true }
        }),
        prisma.paymentTransaction.groupBy({
            by: ['method'],
            where: paymentWhere,
            _sum: { amount: true },
            _count: { id: true }
        }),
        prisma.incomeRecord.groupBy({
            by: ['categoryId'],
            where: ledgerWhere,
            _sum: { amount: true },
            _count: { id: true }
        }),
        prisma.expenseRecord.groupBy({
            by: ['categoryId'],
            where: ledgerWhere,
            _sum: { amount: true },
            _count: { id: true }
        }),
        prisma.financeInvoice.count({
            where: {
                ...invoiceWhere,
                status: { in: ['OPEN', 'SENT', 'PARTIALLY_PAID'] },
                balanceDue: { gt: 0 }
            }
        })
    ]);

    const catIds = [...new Set([
        ...incomeByCategory.map(i => i.categoryId),
        ...expenseByCategory.map(e => e.categoryId)
    ])];

    const categories = await prisma.financeCategory.findMany({
        where: { id: { in: catIds } },
        select: { id: true, name: true, type: true }
    });
    const catMap = new Map(categories.map(c => [c.id, c.name]));

    const totalFeeCollected = feePaymentAgg._sum.amount || 0;
    const totalDirectIncome = incomeAgg._sum.amount || 0;
    const totalInflow = totalFeeCollected + totalDirectIncome;

    const totalPayrollNet = payrollAgg._sum.totalNet || 0;
    const totalDirectExpenses = expenseAgg._sum.amount || 0;
    const totalOutflow = totalPayrollNet + totalDirectExpenses;

    const netOperatingBalance = totalInflow - totalOutflow;
    const totalInvoiced = invoiceAgg._sum.totalAmount || 0;
    const totalOutstanding = invoiceAgg._sum.balanceDue || 0;
    const collectionRate = totalInvoiced > 0 ? ((totalInflow / totalInvoiced) * 100).toFixed(1) : '0.0';

    res.status(StatusCodes.OK).json({
        summary: {
            totalInflow,
            totalOutflow,
            netOperatingBalance,
            totalInvoiced,
            totalFeeCollected,
            totalDirectIncome,
            totalPayrollNet,
            totalDirectExpenses,
            totalOutstanding,
            totalDebtorsCount: debtorsCount,
            collectionRate: Number(collectionRate),
            invoiceCount: invoiceAgg._count.id || 0,
            transactionCount: feePaymentAgg._count.id || 0,
            payrollRunsCount: payrollAgg._count.id || 0
        },
        breakdowns: {
            paymentMethods: feePaymentByMethod.map(m => ({ method: m.method, amount: m._sum.amount || 0, count: m._count.id })),
            incomeCategories: incomeByCategory.map(c => ({ name: catMap.get(c.categoryId) || 'Other Income', amount: c._sum.amount || 0, count: c._count.id })),
            expenseCategories: expenseByCategory.map(c => ({ name: catMap.get(c.categoryId) || 'Other Expense', amount: c._sum.amount || 0, count: c._count.id }))
        }
    });
};

// --- PAYROLL GENERAL REPORT ---
const getPayrollReport = async (req, res) => {
    const { schoolId } = req.user;
    const { month, year, status, search, sortBy = 'date', sortOrder = 'desc', limit = '100', page = '1' } = req.query;

    const payrollWhere = {
        schoolId,
        ...(status && status !== 'ALL' && { status }),
        ...(month && { month: parseInt(month, 10) }),
        ...(year && { year: parseInt(year, 10) })
    };

    const runs = await prisma.payrollRun.findMany({
        where: payrollWhere,
        include: {
            items: {
                include: {
                    staff: {
                        include: {
                            user: { select: { name: true, email: true } }
                        }
                    }
                }
            }
        },
        orderBy: { runDate: 'desc' }
    });

    let staffRecords = [];
    for (const run of runs) {
        for (const item of run.items) {
            staffRecords.push({
                id: item.id,
                runId: run.id,
                month: run.month,
                year: run.year,
                runDate: run.runDate,
                status: run.status,
                staffId: item.staffId,
                staffName: item.staff?.user?.name || 'Staff Member',
                staffEmail: item.staff?.user?.email || '—',
                employeeId: item.staff?.employeeId || '—',
                department: item.staff?.department || item.staff?.staffType || 'Academic',
                gross: item.gross || 0,
                deductions: item.deductions || 0,
                net: item.net || 0,
                breakdown: item.breakdown || null
            });
        }
    }

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        staffRecords = staffRecords.filter(r =>
            r.staffName.toLowerCase().includes(q) ||
            r.employeeId.toLowerCase().includes(q) ||
            r.department.toLowerCase().includes(q) ||
            String(r.month).includes(q) ||
            String(r.year).includes(q)
        );
    }

    staffRecords.sort((a, b) => {
        if (sortBy === 'net' || sortBy === 'amount') return sortOrder === 'asc' ? a.net - b.net : b.net - a.net;
        if (sortBy === 'gross') return sortOrder === 'asc' ? a.gross - b.gross : b.gross - a.gross;
        if (sortBy === 'deductions') return sortOrder === 'asc' ? a.deductions - b.deductions : b.deductions - a.deductions;
        if (sortBy === 'name' || sortBy === 'staff') return sortOrder === 'asc' ? a.staffName.localeCompare(b.staffName) : b.staffName.localeCompare(a.staffName);
        if (sortBy === 'department') return sortOrder === 'asc' ? a.department.localeCompare(b.department) : b.department.localeCompare(a.department);
        const timeA = new Date(a.runDate).getTime();
        const timeB = new Date(b.runDate).getTime();
        return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });

    const totalGross = staffRecords.reduce((s, r) => s + r.gross, 0);
    const totalDeductions = staffRecords.reduce((s, r) => s + r.deductions, 0);
    const totalNet = staffRecords.reduce((s, r) => s + r.net, 0);

    const skip = (Number(page) - 1) * Number(limit);
    const paginated = staffRecords.slice(skip, skip + Number(limit));

    res.status(StatusCodes.OK).json({
        totalStaff: staffRecords.length,
        totalGross,
        totalDeductions,
        totalNet,
        records: paginated
    });
};

// --- INCOME & EXPENSE GENERAL REPORT ---
const getIncomeExpenseReport = async (req, res) => {
    const { schoolId } = req.user;
    const { type = 'ALL', categoryId, month, year, from, to, search, sortBy = 'date', sortOrder = 'desc', limit = '100', page = '1' } = req.query;

    let dateFilter = {};
    if (from || to) {
        dateFilter = {
            ...(from && { gte: new Date(from) }),
            ...(to && { lte: new Date(to) })
        };
    } else if (month && year) {
        const m = parseInt(month, 10);
        const y = parseInt(year, 10);
        const start = new Date(y, m - 1, 1);
        const end = new Date(y, m, 0, 23, 59, 59, 999);
        dateFilter = { gte: start, lte: end };
    } else if (year) {
        const y = parseInt(year, 10);
        const start = new Date(y, 0, 1);
        const end = new Date(y, 11, 31, 23, 59, 59, 999);
        dateFilter = { gte: start, lte: end };
    }

    const hasDateFilter = Object.keys(dateFilter).length > 0;
    const commonWhere = {
        schoolId,
        ...(hasDateFilter && { date: dateFilter }),
        ...(categoryId && categoryId !== 'ALL' && { categoryId })
    };

    const fetchIncomes = type === 'ALL' || type === 'INCOME';
    const fetchExpenses = type === 'ALL' || type === 'EXPENSE';

    const [incomes, expenses] = await Promise.all([
        fetchIncomes ? prisma.incomeRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        }) : Promise.resolve([]),
        fetchExpenses ? prisma.expenseRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        }) : Promise.resolve([])
    ]);

    let records = [
        ...incomes.map(i => ({ ...i, recordType: 'INCOME' })),
        ...expenses.map(e => ({ ...e, recordType: 'EXPENSE' }))
    ];

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        records = records.filter(r =>
            (r.description && r.description.toLowerCase().includes(q)) ||
            (r.category?.name && r.category.name.toLowerCase().includes(q)) ||
            (r.source && r.source.toLowerCase().includes(q)) ||
            (r.referenceId && r.referenceId.toLowerCase().includes(q)) ||
            String(r.amount).includes(q)
        );
    }

    records.sort((a, b) => {
        if (sortBy === 'amount') return sortOrder === 'asc' ? a.amount - b.amount : b.amount - a.amount;
        if (sortBy === 'description') return sortOrder === 'asc' ? (a.description || '').localeCompare(b.description || '') : (b.description || '').localeCompare(a.description || '');
        if (sortBy === 'category') return sortOrder === 'asc' ? (a.category?.name || '').localeCompare(b.category?.name || '') : (b.category?.name || '').localeCompare(a.category?.name || '');
        const timeA = new Date(a.date).getTime();
        const timeB = new Date(b.date).getTime();
        return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });

    const totalIncome = records.filter(r => r.recordType === 'INCOME').reduce((s, r) => s + r.amount, 0);
    const totalExpense = records.filter(r => r.recordType === 'EXPENSE').reduce((s, r) => s + r.amount, 0);
    const netBalance = totalIncome - totalExpense;

    const skip = (Number(page) - 1) * Number(limit);
    const paginated = records.slice(skip, skip + Number(limit));

    res.status(StatusCodes.OK).json({
        totalRecords: records.length,
        totalIncome,
        totalExpense,
        netBalance,
        records: paginated
    });
};

const exportReportCsv = async (req, res) => {
    const { type = 'bills', term, academicYear, method, from, to, status, month, year } = req.query;
    const { schoolId } = req.user;

    let rows = [];
    let filename = `skooly-${type}-report`;
    if (term) filename += `-${term}`;
    if (academicYear) filename += `-${academicYear.replace('/', '-')}`;
    if (month && year) filename += `-${month}-${year}`;
    filename += '.csv';

    if (type === 'bills') {
        const where = { schoolId, isDeleted: false, ...(term && { term }), ...(academicYear && { academicYear }), ...(status && status !== 'ALL' && { status }) };
        const invoices = await prisma.financeInvoice.findMany({
            where, take: 5000,
            include: { student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } } },
            orderBy: { createdAt: 'desc' }
        });
        const header = 'Invoice #,Student,Class,Term,Academic Year,Status,Total Expected,Amount Paid,Balance Due,Created Date';
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
        const where = { schoolId, status: 'SUCCESSFUL', ...(method && method !== 'ALL' && { method }), ...(from || to ? { paidAt: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } } : {}) };
        const txns = await prisma.paymentTransaction.findMany({
            where, take: 5000,
            include: { student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } }, receipt: { select: { receiptNumber: true } } },
            orderBy: { paidAt: 'desc' }
        });
        const header = 'Reference,Student,Class,Payment Method,Amount,Receipt #,Paid Date';
        const dataRows = txns.map(t =>
            [t.reference, t.student?.user?.name, t.student?.classArm?.name, t.method, t.amount, t.receipt?.receiptNumber, t.paidAt?.toISOString().split('T')[0]]
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
        );
        rows = [header, ...dataRows];
    } else if (type === 'outstanding') {
        const where = { schoolId, isDeleted: false, status: { in: ['OPEN', 'SENT', 'PARTIALLY_PAID'] }, balanceDue: { gt: 0 }, ...(term && { term }), ...(academicYear && { academicYear }) };
        const invoices = await prisma.financeInvoice.findMany({
            where, take: 5000,
            include: { student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } }, parent: { include: { user: { select: { name: true } } } } } } },
            orderBy: { balanceDue: 'desc' }
        });
        const header = 'Invoice #,Student,Class,Parent Name,Parent Phone,Status,Total Expected,Amount Paid,Balance Due,Created Date';
        const dataRows = invoices.map(inv =>
            [
                inv.invoiceNumber, inv.student?.user?.name, inv.student?.classArm?.name,
                inv.student?.parent?.user?.name || '—', inv.student?.parent?.phone || inv.student?.phone || '—',
                inv.status, inv.totalAmount, inv.amountPaid, inv.balanceDue,
                inv.createdAt.toISOString().split('T')[0]
            ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
        );
        rows = [header, ...dataRows];
    } else if (type === 'payroll') {
        const payrollWhere = { schoolId, ...(month && { month: parseInt(month, 10) }), ...(year && { year: parseInt(year, 10) }) };
        const runs = await prisma.payrollRun.findMany({
            where: payrollWhere,
            include: { items: { include: { staff: { include: { user: { select: { name: true, email: true } } } } } } },
            orderBy: { runDate: 'desc' }
        });
        const header = 'Staff Name,Employee ID,Department,Month,Year,Gross Pay,Deductions,Net Pay,Status,Run Date';
        const dataRows = [];
        for (const run of runs) {
            for (const item of run.items) {
                dataRows.push(
                    [
                        item.staff?.user?.name || 'Staff',
                        item.staff?.employeeId || '—',
                        item.staff?.department || item.staff?.staffType || 'Academic',
                        run.month,
                        run.year,
                        item.gross,
                        item.deductions,
                        item.net,
                        run.status,
                        run.runDate?.toISOString().split('T')[0]
                    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
                );
            }
        }
        rows = [header, ...dataRows];
    } else if (type === 'income' || type === 'expenses' || type === 'ledger') {
        const isIncome = type === 'income';
        const isExpense = type === 'expenses';
        const [incomes, expenses] = await Promise.all([
            (!isExpense) ? prisma.incomeRecord.findMany({ where: { schoolId }, include: { category: true }, orderBy: { date: 'desc' }, take: 5000 }) : Promise.resolve([]),
            (!isIncome) ? prisma.expenseRecord.findMany({ where: { schoolId }, include: { category: true }, orderBy: { date: 'desc' }, take: 5000 }) : Promise.resolve([])
        ]);
        const header = 'Type,Category,Description,Amount,Source,Reference,Date';
        const dataRows = [
            ...incomes.map(i => ['INCOME', i.category?.name, i.description, i.amount, i.source, i.referenceId || '—', i.date?.toISOString().split('T')[0]]),
            ...expenses.map(e => ['EXPENSE', e.category?.name, e.description, e.amount, e.source, e.referenceId || '—', e.date?.toISOString().split('T')[0]])
        ].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
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

// ─── LEDGER DATE RESOLVER HELPER ─────────────────────────────────────────────

async function resolveLedgerDateRange({ schoolId, from, to, session, sessionId, academicYear, term, termId, month }) {
    const yearVal = sessionId || session || academicYear;
    const termVal = termId || term;
    let startDate = null;
    let endDate = null;

    if (from) {
        startDate = new Date(from);
        startDate.setHours(0, 0, 0, 0);
    }
    if (to) {
        endDate = new Date(to);
        endDate.setHours(23, 59, 59, 999);
    }

    // If month is provided (e.g. '2026-05' or 5 or 'May') and no custom from/to
    if (month && !from && !to) {
        let yearNum = new Date().getFullYear();
        let monthNum = null;

        if (typeof month === 'string' && month.includes('-')) {
            const parts = month.split('-');
            yearNum = parseInt(parts[0], 10);
            monthNum = parseInt(parts[1], 10) - 1;
        } else if (!isNaN(Number(month))) {
            monthNum = Number(month) - 1;
            if (yearVal && typeof yearVal === 'string' && yearVal.includes('/')) {
                const yPart = parseInt(yearVal.split('/')[0], 10);
                if (!isNaN(yPart)) yearNum = yPart;
            }
        } else if (typeof month === 'string') {
            const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
            const idx = monthNames.findIndex(m => m.startsWith(month.toLowerCase().slice(0, 3)));
            if (idx !== -1) monthNum = idx;
        }

        if (monthNum !== null && monthNum >= 0 && monthNum <= 11) {
            startDate = new Date(yearNum, monthNum, 1, 0, 0, 0, 0);
            endDate = new Date(yearNum, monthNum + 1, 0, 23, 59, 59, 999);
        }
    }

    // If term and/or academic session are provided and no explicit custom dates overrode it
    if ((termVal || yearVal) && !from && !to && !month) {
        const termNameMap = {
            'FIRST_TERM': 'First Term',
            'SECOND_TERM': 'Second Term',
            'THIRD_TERM': 'Third Term'
        };
        const mappedTermName = termVal ? (termNameMap[termVal] || termVal) : null;

        // If term ID or name is provided, search term directly
        if (termVal) {
            const academicTerm = await prisma.academicTerm.findFirst({
                where: {
                    schoolId,
                    OR: [
                        { id: termVal },
                        { name: mappedTermName }
                    ],
                    ...(yearVal && {
                        OR: [
                            { id: termVal },
                            {
                                name: mappedTermName,
                                session: {
                                    OR: [{ id: yearVal }, { name: yearVal }]
                                }
                            }
                        ]
                    })
                }
            });

            if (academicTerm?.startDate && academicTerm?.endDate) {
                startDate = new Date(academicTerm.startDate);
                endDate = new Date(academicTerm.endDate);
                endDate.setHours(23, 59, 59, 999);
            }
        } else if (yearVal) {
            const sessionRecord = await prisma.academicSession.findFirst({
                where: {
                    schoolId,
                    OR: [
                        { id: yearVal },
                        { name: yearVal }
                    ]
                }
            });

            if (sessionRecord?.startDate && sessionRecord?.endDate) {
                startDate = new Date(sessionRecord.startDate);
                endDate = new Date(sessionRecord.endDate);
                endDate.setHours(23, 59, 59, 999);
            }
        }
    }

    const dateFilter = {};
    if (startDate) dateFilter.gte = startDate;
    if (endDate) dateFilter.lte = endDate;

    return { startDate, endDate, dateFilter };
}

// ─── LEDGER RECORDS (INCOME & EXPENSES) ────────────────────────────────────────

const getLedgerRecords = async (req, res) => {
    const { schoolId } = req.user;
    const {
        type, from, to, source, categoryId,
        session, sessionId, academicYear, term, termId, month,
        search, sortBy = 'date', sortOrder = 'desc',
        page, limit
    } = req.query;

    const { dateFilter, startDate, endDate } = await resolveLedgerDateRange({
        schoolId, from, to, session, sessionId, academicYear, term, termId, month
    });

    const commonWhere = { schoolId };
    if (Object.keys(dateFilter).length > 0) commonWhere.date = dateFilter;
    if (source && source !== 'ALL') commonWhere.source = source;
    if (categoryId && categoryId !== 'ALL') commonWhere.categoryId = categoryId;

    let records = [];

    const fetchIncomes = !type || type === 'ALL' || type === 'INCOME';
    const fetchExpenses = !type || type === 'ALL' || type === 'EXPENSE';

    const [incomes, expenses] = await Promise.all([
        fetchIncomes ? prisma.incomeRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        }) : Promise.resolve([]),
        fetchExpenses ? prisma.expenseRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        }) : Promise.resolve([])
    ]);

    records.push(...incomes.map(i => ({ ...i, recordType: 'INCOME' })));
    records.push(...expenses.map(e => ({ ...e, recordType: 'EXPENSE' })));

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        records = records.filter(r => 
            (r.description && r.description.toLowerCase().includes(q)) ||
            (r.category?.name && r.category.name.toLowerCase().includes(q)) ||
            (r.source && r.source.toLowerCase().includes(q)) ||
            (r.referenceId && r.referenceId.toLowerCase().includes(q)) ||
            (String(r.amount).includes(q))
        );
    }

    records.sort((a, b) => {
        if (sortBy === 'amount') {
            return sortOrder === 'asc' ? a.amount - b.amount : b.amount - a.amount;
        }
        if (sortBy === 'description') {
            return sortOrder === 'asc' 
                ? (a.description || '').localeCompare(b.description || '')
                : (b.description || '').localeCompare(a.description || '');
        }
        if (sortBy === 'category') {
            return sortOrder === 'asc'
                ? (a.category?.name || '').localeCompare(b.category?.name || '')
                : (b.category?.name || '').localeCompare(a.category?.name || '');
        }
        const timeA = new Date(a.date).getTime();
        const timeB = new Date(b.date).getTime();
        return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });

    const totalIncome = records.filter(r => r.recordType === 'INCOME').reduce((acc, r) => acc + (r.amount || 0), 0);
    const totalExpense = records.filter(r => r.recordType === 'EXPENSE').reduce((acc, r) => acc + (r.amount || 0), 0);
    const netBalance = totalIncome - totalExpense;
    const autoCount = records.filter(r => r.source === 'AUTO').length;
    const manualCount = records.filter(r => r.source === 'MANUAL').length;

    let paginatedRecords = records;
    const pageNum = page ? parseInt(page, 10) : null;
    const limitNum = limit ? parseInt(limit, 10) : null;
    if (pageNum && limitNum) {
        const start = (pageNum - 1) * limitNum;
        paginatedRecords = records.slice(start, start + limitNum);
    }

    res.status(StatusCodes.OK).json({
        totalRecords: records.length,
        totalIncome,
        totalExpense,
        netBalance,
        autoCount,
        manualCount,
        records: paginatedRecords,
        allRecords: records,
        periodSummary: {
            from: startDate ? startDate.toISOString() : null,
            to: endDate ? endDate.toISOString() : null,
            session: session || academicYear || null,
            term: term || null,
            month: month || null
        }
    });
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
    const {
        from, to, session, sessionId, academicYear, term, termId, month, search
    } = req.query;

    const { dateFilter, startDate, endDate } = await resolveLedgerDateRange({
        schoolId, from, to, session, sessionId, academicYear, term, termId, month
    });

    const commonWhere = { schoolId };
    if (Object.keys(dateFilter).length > 0) commonWhere.date = dateFilter;

    // Fetch all categories for this school
    const categories = await prisma.financeCategory.findMany({
        where: { schoolId },
        orderBy: { name: 'asc' }
    });

    // Fetch all income and expense records for this period
    const [incomeRecords, expenseRecords] = await Promise.all([
        prisma.incomeRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        }),
        prisma.expenseRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'desc' }
        })
    ]);

    // Group income by category with full list of underlying transactions
    const incomeCatMap = {};
    for (const cat of categories.filter(c => c.type === 'INCOME')) {
        incomeCatMap[cat.id] = {
            categoryId: cat.id,
            categoryName: cat.name,
            amount: 0,
            transactions: []
        };
    }
    const uncategorizedIncome = {
        categoryId: 'uncategorized',
        categoryName: 'Uncategorized Income',
        amount: 0,
        transactions: []
    };

    let totalIncome = 0;
    for (const rec of incomeRecords) {
        totalIncome += rec.amount;
        const target = incomeCatMap[rec.categoryId] || uncategorizedIncome;
        target.amount += rec.amount;
        target.transactions.push({
            id: rec.id,
            description: rec.description,
            amount: rec.amount,
            date: rec.date,
            source: rec.source,
            referenceId: rec.referenceId
        });
    }

    let incomes = Object.values(incomeCatMap);
    if (uncategorizedIncome.transactions.length > 0) {
        incomes.push(uncategorizedIncome);
    }

    // Group expenses by category with full list of underlying transactions
    const expenseCatMap = {};
    for (const cat of categories.filter(c => c.type === 'EXPENSE')) {
        expenseCatMap[cat.id] = {
            categoryId: cat.id,
            categoryName: cat.name,
            amount: 0,
            transactions: []
        };
    }
    const uncategorizedExpense = {
        categoryId: 'uncategorized',
        categoryName: 'Uncategorized Expenses',
        amount: 0,
        transactions: []
    };

    let totalExpense = 0;
    for (const rec of expenseRecords) {
        totalExpense += rec.amount;
        const target = expenseCatMap[rec.categoryId] || uncategorizedExpense;
        target.amount += rec.amount;
        target.transactions.push({
            id: rec.id,
            description: rec.description,
            amount: rec.amount,
            date: rec.date,
            source: rec.source,
            referenceId: rec.referenceId
        });
    }

    let expenses = Object.values(expenseCatMap);
    if (uncategorizedExpense.transactions.length > 0) {
        expenses.push(uncategorizedExpense);
    }

    // Search filter if provided
    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        incomes = incomes.map(cat => {
            const matchesCat = cat.categoryName.toLowerCase().includes(q);
            const filteredTx = cat.transactions.filter(t => 
                (t.description && t.description.toLowerCase().includes(q)) ||
                (t.source && t.source.toLowerCase().includes(q)) ||
                (t.referenceId && t.referenceId.toLowerCase().includes(q)) ||
                String(t.amount).includes(q)
            );
            if (matchesCat) return cat;
            return {
                ...cat,
                transactions: filteredTx,
                amount: filteredTx.reduce((sum, t) => sum + t.amount, 0)
            };
        }).filter(cat => cat.transactions.length > 0 || cat.categoryName.toLowerCase().includes(q));

        expenses = expenses.map(cat => {
            const matchesCat = cat.categoryName.toLowerCase().includes(q);
            const filteredTx = cat.transactions.filter(t => 
                (t.description && t.description.toLowerCase().includes(q)) ||
                (t.source && t.source.toLowerCase().includes(q)) ||
                (t.referenceId && t.referenceId.toLowerCase().includes(q)) ||
                String(t.amount).includes(q)
            );
            if (matchesCat) return cat;
            return {
                ...cat,
                transactions: filteredTx,
                amount: filteredTx.reduce((sum, t) => sum + t.amount, 0)
            };
        }).filter(cat => cat.transactions.length > 0 || cat.categoryName.toLowerCase().includes(q));
    }

    // Calculate percentage shares
    incomes = incomes.map(c => ({
        ...c,
        percentage: totalIncome > 0 ? Number(((c.amount / totalIncome) * 100).toFixed(1)) : 0
    }));

    expenses = expenses.map(c => ({
        ...c,
        percentage: totalExpense > 0 ? Number(((c.amount / totalExpense) * 100).toFixed(1)) : 0
    }));

    const netProfit = totalIncome - totalExpense;
    const profitMarginPercentage = totalIncome > 0 ? Number(((netProfit / totalIncome) * 100).toFixed(1)) : 0;

    // Build monthly trend for the period (or last 6 months)
    let trendStart = startDate;
    let trendEnd = endDate || new Date();
    if (!trendStart) {
        trendStart = new Date();
        trendStart.setMonth(trendStart.getMonth() - 5);
        trendStart.setDate(1);
    }

    const trendWhere = {
        schoolId,
        date: {
            gte: trendStart,
            ...(endDate && { lte: trendEnd })
        }
    };

    const [trendIncomes, trendExpenses] = await Promise.all([
        prisma.incomeRecord.findMany({ where: trendWhere, select: { amount: true, date: true } }),
        prisma.expenseRecord.findMany({ where: trendWhere, select: { amount: true, date: true } })
    ]);

    const monthsMap = {};
    const curr = new Date(trendStart);
    curr.setDate(1);
    const stop = new Date(trendEnd);

    let safetyCounter = 0;
    while (curr <= stop && safetyCounter < 24) {
        const key = curr.toLocaleString('default', { month: 'short', year: 'numeric' });
        monthsMap[key] = { month: key, income: 0, expense: 0, sortKey: curr.getTime() };
        curr.setMonth(curr.getMonth() + 1);
        safetyCounter++;
    }

    trendIncomes.forEach(r => {
        const key = new Date(r.date).toLocaleString('default', { month: 'short', year: 'numeric' });
        if (monthsMap[key]) monthsMap[key].income += r.amount;
    });

    trendExpenses.forEach(r => {
        const key = new Date(r.date).toLocaleString('default', { month: 'short', year: 'numeric' });
        if (monthsMap[key]) monthsMap[key].expense += r.amount;
    });

    const monthlyTrend = Object.values(monthsMap).sort((a, b) => a.sortKey - b.sortKey);

    const normalizedIncomes = incomes.map(c => ({
        id: c.categoryId,
        name: c.categoryName,
        total: c.amount,
        percentageOfTotal: c.percentage,
        transactions: c.transactions
    }));

    const normalizedExpenses = expenses.map(c => ({
        id: c.categoryId,
        name: c.categoryName,
        total: c.amount,
        percentageOfTotal: c.percentage,
        transactions: c.transactions
    }));

    res.status(StatusCodes.OK).json({
        totalIncome,
        totalExpense,
        netProfit,
        profitMarginPercentage,
        profitMarginPercent: profitMarginPercentage,
        incomes,
        expenses,
        incomeCategories: normalizedIncomes,
        expenseCategories: normalizedExpenses,
        monthlyTrend,
        periodSummary: {
            from: startDate ? startDate.toISOString() : null,
            to: endDate ? endDate.toISOString() : null,
            session: session || academicYear || null,
            term: term || null,
            month: month || null
        }
    });
};

const exportLedgerCsv = async (req, res) => {
    const { schoolId } = req.user;
    const {
        type, from, to, source, categoryId,
        session, sessionId, academicYear, term, termId, month, search
    } = req.query;

    const { dateFilter } = await resolveLedgerDateRange({
        schoolId, from, to, session, sessionId, academicYear, term, termId, month
    });

    const commonWhere = { schoolId };
    if (Object.keys(dateFilter).length > 0) commonWhere.date = dateFilter;
    if (source && source !== 'ALL') commonWhere.source = source;
    if (categoryId && categoryId !== 'ALL') commonWhere.categoryId = categoryId;

    let records = [];

    const fetchIncomes = !type || type === 'ALL' || type === 'INCOME';
    const fetchExpenses = !type || type === 'ALL' || type === 'EXPENSE';

    const [incomes, expenses] = await Promise.all([
        fetchIncomes ? prisma.incomeRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'asc' }
        }) : Promise.resolve([]),
        fetchExpenses ? prisma.expenseRecord.findMany({
            where: commonWhere,
            include: { category: true },
            orderBy: { date: 'asc' }
        }) : Promise.resolve([])
    ]);

    records.push(...incomes.map(i => ({ ...i, recordType: 'INCOME' })));
    records.push(...expenses.map(e => ({ ...e, recordType: 'EXPENSE' })));

    records.sort((a, b) => new Date(a.date) - new Date(b.date));

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        records = records.filter(r => 
            (r.description && r.description.toLowerCase().includes(q)) ||
            (r.category?.name && r.category.name.toLowerCase().includes(q)) ||
            (r.source && r.source.toLowerCase().includes(q)) ||
            (r.referenceId && r.referenceId.toLowerCase().includes(q)) ||
            (String(r.amount).includes(q))
        );
    }

    let runningBalance = 0;
    const dataRows = records.map(r => {
        const isInflow = r.recordType === 'INCOME';
        const inflow = isInflow ? r.amount : 0;
        const outflow = !isInflow ? r.amount : 0;
        runningBalance += (inflow - outflow);

        return [
            new Date(r.date).toISOString().split('T')[0],
            r.recordType,
            r.category?.name || 'Uncategorized',
            r.description,
            r.source,
            inflow > 0 ? inflow : '',
            outflow > 0 ? outflow : '',
            runningBalance
        ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
    });

    const header = ['Date', 'Type', 'Category', 'Description', 'Source', 'Inflow (+)', 'Outflow (-)', 'Running Balance'];
    const csv = [header.join(','), ...dataRows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="finance_ledger_statement.csv"');
    res.status(200).send(csv);
};


const getMyFamilyWallet = async (req, res) => {
    const { schoolId, userId } = req.user;

    const parent = await prisma.parentProfile.findUnique({
        where: { userId },
        include: {
            user: { select: { name: true, email: true } },
            FamilyWallet: {
                include: {
                    transactions: { orderBy: { createdAt: 'desc' }, take: 20 }
                }
            },
            students: {
                where: { isDeleted: false },
                include: {
                    user: { select: { name: true } },
                    StudentWallet: {
                        include: {
                            transactions: {
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
        throw new CustomError.NotFoundError('Parent profile not found');
    }

    let familyWallet = parent.FamilyWallet;
    if (!familyWallet) {
        familyWallet = await prisma.familyWallet.create({
            data: { schoolId, parentId: parent.id }
        });
        familyWallet.transactions = [];
    }

    const individualWallets = parent.students.map(student => {
        const wallet = student.StudentWallet;
        return {
            studentId: student.id,
            studentName: student.user?.name,
            admissionNo: student.admissionNo,
            balance: wallet ? wallet.balance : 0,
            status: wallet ? wallet.status : 'ACTIVE',
            transactions: wallet ? wallet.transactions : []
        };
    });

    const totalIndividualBalance = individualWallets.reduce((acc, curr) => acc + curr.balance, 0);
    const totalFamilyBalance = familyWallet.balance + totalIndividualBalance;

    res.status(StatusCodes.OK).json({
        parentName: parent.user?.name,
        familyWalletBalance: familyWallet.balance,
        totalFamilyBalance,
        familyWallet: { ...familyWallet, transactions: mergeFamilyLedger(familyWallet, individualWallets) },
        individualWallets
    });
};


// ==========================================
// ADMIN DASHBOARD ACTIVITY FEED
// ==========================================
const getDashboardActivity = async (req, res) => {
    const { schoolId } = req.user;

    // Fetch recent payments
    const payments = await prisma.paymentTransaction.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
            student: {
                include: { user: true }
            }
        }
    });

    // Fetch recent messages
    const messages = await prisma.financeMessage.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: 10
    });
    
    // Fetch user names for messages
    const userIds = [...new Set(messages.flatMap(m => [m.senderId, m.receiverId].filter(Boolean)))];
    const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true }
    });
    const userMap = users.reduce((acc, user) => {
        acc[user.id] = user.name;
        return acc;
    }, {});

    const activities = [];

    for (const p of payments) {
        activities.push({
            id: 'pay_' + p.id,
            type: 'PAYMENT',
            title: `Payment Logged - ₦${p.amount}`,
            description: `Payment via ${p.method} for ${p.student?.user?.name || 'Student'}`,
            createdAt: p.createdAt,
            status: p.status
        });
    }

    for (const m of messages) {
        const isParentReply = m.senderType === 'PARENT';
        const senderName = userMap[m.senderId] || 'User';
        const receiverName = userMap[m.receiverId] || 'User';
        
        activities.push({
            id: 'msg_' + m.id,
            type: isParentReply ? 'PARENT_REPLY' : 'MESSAGE_SENT',
            title: isParentReply ? 'Parent Replied to Reminder' : 'Reminder Sent',
            description: isParentReply 
                ? `${senderName} replied: ${m.body.substring(0, 50)}...`
                : `Sent to ${receiverName}: ${m.subject}`,
            createdAt: m.createdAt,
            status: 'SUCCESS'
        });
    }

    activities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.status(200).json({
        activities: activities.slice(0, 10)
    });
};

const { uploadTransferEvidence } = require('../services/cloudinary-upload.service');

const disputeInvoice = async (req, res) => {
    const { schoolId, userId } = req.user;
    const { id } = req.params;
    let { reason } = req.body;

    let attachmentUrl = null;
    if (req.files && req.files.evidence) {
        const result = await uploadTransferEvidence(req.files.evidence, schoolId, userId);
        attachmentUrl = result.secure_url;
    }

    if (!reason && !attachmentUrl) {
        throw new CustomError.BadRequestError('Dispute reason or evidence is required');
    }

    const invoice = await prisma.financeInvoice.findUnique({
        where: { id }
    });

    if (!invoice || invoice.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Invoice not found');
    }

    await prisma.financeInvoice.update({
        where: { id },
        data: {
            isDisputed: true,
            disputeReason: reason || 'Evidence attached'
        }
    });

    await prisma.financeMessage.create({
        data: {
            schoolId,
            senderType: 'PARENT',
            senderId: userId,
            invoiceId: invoice.id,
            subject: 'Invoice Disputed: ' + invoice.invoiceNumber,
            body: reason || 'Parent attached evidence for dispute.',
            attachmentUrl
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Invoice disputed successfully' });
};

module.exports = {
    disputeInvoice,
    getDashboardActivity,
    getFinanceDashboard,
    getFinanceSettings,
    updateFinanceSettings,
    getFeeDefinitions,
    createFeeDefinition,
    updateFeeDefinition,
    deleteFeeDefinition,
    getFeeRules,
    createFeeRule,
    updateFeeRule,
    deleteFeeRule,
    getStudentWallet,
    getFamilyWallet,
    getMyFamilyWallet,
    fundWallet,
    // Phase 10 & 14 Reports
    getBillsReport,
    getPaymentsReport,
    getItemsReport,
    getOutstandingReport,
    getExecutiveReportSummary,
    getPayrollReport,
    getIncomeExpenseReport,
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


