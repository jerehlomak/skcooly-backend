'use strict';

const prisma = require('../db/prisma');

// All roles that can access payroll management
const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN', 'BRANCH_ADMIN', 'BRANCH_STAFF'];

function schoolId(req) {
    return req.user?.schoolId || null;
}

function fmtMonthName(month) {
    const names = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return names[(month - 1)] || 'Unknown';
}

// Wraps async handlers — logs real error to console and returns clean JSON
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
    console.error(`[PAYROLL ERROR] ${req.method} ${req.path}:`, err?.message || err);
    if (!res.headersSent) {
        res.status(500).json({ success: false, message: err?.message || 'Internal server error', msg: err?.message || 'Internal server error' });
    }
});

// ─── STAFF LIST ───────────────────────────────────────────────────────────────

/**
 * GET /payroll/staff
 * Returns all active staff with their payroll summary (gross, deductions, net)
 */
const getPayrollStaff = asyncHandler(async function(req, res) {
    const sid = schoolId(req);

    const staff = await prisma.teacherProfile.findMany({
        where: { schoolId: sid, isDeleted: false, status: 'Active' },
        include: {
            user: { select: { name: true, email: true } },
            payrollSettings: true,
        },
        orderBy: { user: { name: 'asc' } },
    });

    const result = staff.map(s => {
        const earnings = s.payrollSettings.filter(p => p.type === 'earning');
        const deductions = s.payrollSettings.filter(p => p.type === 'deduction');
        const gross = earnings.reduce((sum, e) => sum + e.amount, 0);
        const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);
        const net = gross - totalDeductions;

        return {
            id: s.id,
            userId: s.userId,
            name: s.user?.name ?? 'Unknown',
            email: s.user?.email ?? '',
            department: s.department ?? '',
            employeeId: s.employeeId,
            bankName: s.bankName ?? '',
            accountNumber: s.accountNumber ?? '',
            accountName: s.accountName ?? '',
            gross,
            totalDeductions,
            net,
            earningsCount: earnings.length,
            deductionsCount: deductions.length,
        };
    });

    res.json({ success: true, staff: result });
});

// ─── PAYROLL SETTINGS ─────────────────────────────────────────────────────────

/**
 * GET /payroll/settings/:staffId
 */
const getPayrollSettings = asyncHandler(async function(req, res) {
    const { staffId } = req.params;
    const sid = schoolId(req);

    const settings = await prisma.payrollSetting.findMany({
        where: { staffId, schoolId: sid },
        orderBy: { createdAt: 'asc' },
    });

    const earnings = settings.filter(s => s.type === 'earning');
    const deductions = settings.filter(s => s.type === 'deduction');
    const gross = earnings.reduce((sum, e) => sum + e.amount, 0);
    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);

    res.json({
        success: true,
        settings,
        earnings,
        deductions,
        gross,
        totalDeductions,
        net: gross - totalDeductions,
    });
});

/**
 * POST /payroll/settings
 * Body: { staffId, type, itemName, amount }
 */
const createPayrollSetting = asyncHandler(async function(req, res) {
    const { staffId, type, itemName, amount } = req.body;
    const sid = schoolId(req);

    if (!staffId || !type || !itemName || amount === undefined) {
        return res.status(400).json({ success: false, message: 'staffId, type, itemName, and amount are required.' });
    }
    if (!['earning', 'deduction'].includes(type)) {
        return res.status(400).json({ success: false, message: 'type must be "earning" or "deduction".' });
    }

    const setting = await prisma.payrollSetting.create({
        data: { schoolId: sid, staffId, type, itemName, amount: parseFloat(amount) },
    });

    res.status(201).json({ success: true, setting });
});

/**
 * PUT /payroll/settings/:id
 * Body: { itemName?, amount? }
 */
const updatePayrollSetting = asyncHandler(async function(req, res) {
    const { id } = req.params;
    const { itemName, amount } = req.body;

    const existing = await prisma.payrollSetting.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Setting not found.' });

    const updated = await prisma.payrollSetting.update({
        where: { id },
        data: {
            ...(itemName && { itemName }),
            ...(amount !== undefined && { amount: parseFloat(amount) }),
        },
    });

    res.json({ success: true, setting: updated });
});

/**
 * DELETE /payroll/settings/:id
 */
const deletePayrollSetting = asyncHandler(async function(req, res) {
    const { id } = req.params;
    const existing = await prisma.payrollSetting.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Setting not found.' });
    await prisma.payrollSetting.delete({ where: { id } });
    res.json({ success: true, message: 'Setting deleted.' });
});

// ─── LOAN MANAGEMENT ─────────────────────────────────────────────────────────

/**
 * GET /payroll/loans/:staffId
 */
const getStaffLoans = asyncHandler(async function(req, res) {
    const { staffId } = req.params;
    const sid = schoolId(req);

    const loans = await prisma.staffLoan.findMany({
        where: { staffId, schoolId: sid },
        include: {
            repayments: {
                orderBy: { date: 'desc' },
                include: { payrollRun: { select: { month: true, year: true, runDate: true } } }
            }
        },
        orderBy: { createdAt: 'desc' },
    });

    const totalLoaned = loans.reduce((s, l) => s + l.loanAmount, 0);
    const totalOutstanding = loans
        .filter(l => l.status === 'active')
        .reduce((s, l) => s + l.outstandingBalance, 0);
    const totalRepaid = totalLoaned - totalOutstanding;

    res.json({ success: true, loans, totalLoaned, totalOutstanding, totalRepaid });
});

/**
 * POST /payroll/loans
 * Body: { staffId, loanAmount, dateCollected?, repaymentPerMonth?, notes? }
 */
const createStaffLoan = asyncHandler(async function(req, res) {
    const { staffId, loanAmount, dateCollected, repaymentPerMonth, notes } = req.body;
    const sid = schoolId(req);

    if (!staffId || !loanAmount) {
        return res.status(400).json({ success: false, message: 'staffId and loanAmount are required.' });
    }

    const loan = await prisma.staffLoan.create({
        data: {
            schoolId: sid, staffId,
            loanAmount: parseFloat(loanAmount),
            dateCollected: dateCollected ? new Date(dateCollected) : new Date(),
            repaymentPerMonth: repaymentPerMonth ? parseFloat(repaymentPerMonth) : 0,
            outstandingBalance: parseFloat(loanAmount),
            notes: notes ?? null,
            status: 'active',
        },
    });

    res.status(201).json({ success: true, loan });
});

/**
 * PUT /payroll/loans/:id
 * Body: { repaymentPerMonth?, outstandingBalance?, status?, notes? }
 */
const updateStaffLoan = asyncHandler(async function(req, res) {
    const { id } = req.params;
    const { repaymentPerMonth, outstandingBalance, status, notes } = req.body;

    const existing = await prisma.staffLoan.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Loan not found.' });

    const updated = await prisma.staffLoan.update({
        where: { id },
        data: {
            ...(repaymentPerMonth !== undefined && { repaymentPerMonth: parseFloat(repaymentPerMonth) }),
            ...(outstandingBalance !== undefined && { outstandingBalance: parseFloat(outstandingBalance) }),
            ...(status && { status }),
            ...(notes !== undefined && { notes }),
        },
    });

    res.json({ success: true, loan: updated });
});

/**
 * POST /payroll/loans/repayment
 * Body: { loanId, amount, date?, notes?, source? }
 * Records manual repayment (cash, transfer, direct settlement)
 */
const recordLoanRepayment = asyncHandler(async function(req, res) {
    const { loanId, amount, date, notes, source } = req.body;
    const sid = schoolId(req);

    if (!loanId || !amount || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'loanId and valid amount are required.' });
    }

    const loan = await prisma.staffLoan.findFirst({
        where: { id: loanId, schoolId: sid },
    });
    if (!loan) return res.status(404).json({ success: false, message: 'Loan not found.' });

    const payAmt = parseFloat(amount);
    const newBalance = Math.max(0, loan.outstandingBalance - payAmt);
    const newStatus = newBalance <= 0 ? 'cleared' : loan.status;

    const result = await prisma.$transaction(async (tx) => {
        const updatedLoan = await tx.staffLoan.update({
            where: { id: loanId },
            data: {
                outstandingBalance: newBalance,
                status: newStatus,
            }
        });

        const repayment = await tx.staffLoanRepayment.create({
            data: {
                schoolId: sid,
                loanId,
                staffId: loan.staffId,
                amount: payAmt,
                date: date ? new Date(date) : new Date(),
                source: source || 'MANUAL',
                notes: notes || 'Direct loan repayment',
            }
        });

        return { loan: updatedLoan, repayment };
    });

    res.status(201).json({ success: true, ...result, message: 'Loan repayment recorded successfully.' });
});

// ─── PENSION TRACKER ─────────────────────────────────────────────────────────

/**
 * GET /payroll/pension/:staffId
 */
const getStaffPension = asyncHandler(async function(req, res) {
    const { staffId } = req.params;
    const sid = schoolId(req);

    const entries = await prisma.pensionLedger.findMany({
        where: { staffId, schoolId: sid },
        orderBy: { date: 'desc' },
        include: { payrollRun: { select: { month: true, year: true, runDate: true } } },
    });

    const totalAccumulated = entries.reduce((sum, e) => sum + e.amount, 0);
    res.json({ success: true, entries, totalAccumulated });
});

/**
 * POST /payroll/pension/adhoc
 * Body: { staffId, amount, date?, notes? }
 */
const addAdhocPension = asyncHandler(async function(req, res) {
    const { staffId, amount, date } = req.body;
    const sid = schoolId(req);

    if (!staffId || !amount || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'staffId and positive amount are required.' });
    }

    const entry = await prisma.pensionLedger.create({
        data: {
            schoolId: sid,
            staffId,
            amount: parseFloat(amount),
            date: date ? new Date(date) : new Date(),
        }
    });

    res.status(201).json({ success: true, entry, message: 'Pension contribution added successfully.' });
});

/**
 * POST /payroll/pension/setting
 * Body: { staffId, amount }
 * Sets or updates ongoing monthly pension deduction in PayrollSetting
 */
const setOngoingPension = asyncHandler(async function(req, res) {
    const { staffId, amount } = req.body;
    const sid = schoolId(req);

    if (!staffId || amount === undefined || parseFloat(amount) < 0) {
        return res.status(400).json({ success: false, message: 'staffId and valid amount are required.' });
    }

    const parsedAmount = parseFloat(amount);

    // Check if staff has existing pension deduction setting
    const existing = await prisma.payrollSetting.findFirst({
        where: {
            staffId,
            schoolId: sid,
            type: 'deduction',
            itemName: { contains: 'Pension', mode: 'insensitive' }
        }
    });

    let setting;
    if (parsedAmount === 0 && existing) {
        await prisma.payrollSetting.delete({ where: { id: existing.id } });
        return res.json({ success: true, message: 'Ongoing monthly pension removed.' });
    } else if (existing) {
        setting = await prisma.payrollSetting.update({
            where: { id: existing.id },
            data: { amount: parsedAmount }
        });
    } else {
        setting = await prisma.payrollSetting.create({
            data: {
                schoolId: sid,
                staffId,
                type: 'deduction',
                itemName: 'Pension Contribution',
                amount: parsedAmount
            }
        });
    }

    res.json({ success: true, setting, message: 'Ongoing monthly pension configured successfully.' });
});

/**
 * GET /payroll/pension/summary
 * Aggregate school-wide pension statistics
 */
const getSchoolPensionSummary = asyncHandler(async function(req, res) {
    const sid = schoolId(req);

    const [entries, staffWithPension] = await Promise.all([
        prisma.pensionLedger.findMany({
            where: { schoolId: sid },
            select: { amount: true, date: true, staffId: true }
        }),
        prisma.teacherProfile.findMany({
            where: { schoolId: sid, isDeleted: false },
            include: {
                user: { select: { name: true } },
                payrollSettings: {
                    where: { type: 'deduction', itemName: { contains: 'Pension', mode: 'insensitive' } }
                }
            }
        })
    ]);

    const totalAccumulated = entries.reduce((sum, e) => sum + e.amount, 0);
    const uniqueContributors = new Set(entries.map(e => e.staffId)).size;
    const currentYear = new Date().getFullYear();
    const thisYearTotal = entries
        .filter(e => new Date(e.date).getFullYear() === currentYear)
        .reduce((sum, e) => sum + e.amount, 0);

    res.json({
        success: true,
        summary: {
            totalAccumulated,
            uniqueContributors,
            thisYearTotal,
            staffConfiguredCount: staffWithPension.filter(s => s.payrollSettings.length > 0).length,
            totalStaff: staffWithPension.length
        }
    });
});

// ─── PAYROLL RUN ──────────────────────────────────────────────────────────────

/**
 * POST /payroll/run
 * Body: { month, year }
 * Creates a draft payroll run by fetching all active staff + their payroll settings.
 */
const createPayrollRun = asyncHandler(async function(req, res) {
    const { month, year } = req.body;
    const sid = schoolId(req);
    const createdBy = req.user?.name ?? req.user?.email ?? 'Admin';

    if (!sid) return res.status(400).json({ success: false, message: 'School context required. Please log out and log back in.' });
    if (!month || !year) return res.status(400).json({ success: false, message: 'month and year are required.' });

    // Check if a run already exists for this month/year
    const existing = await prisma.payrollRun.findFirst({
        where: { schoolId: sid, month: parseInt(month), year: parseInt(year) },
    });
    if (existing) {
        return res.status(409).json({
            success: false,
            message: `A payroll run for ${fmtMonthName(month)} ${year} already exists (status: ${existing.status}).`,
            run: existing,
        });
    }

    // Fetch all active staff with their payroll settings and active loans
    const allStaff = await prisma.teacherProfile.findMany({
        where: {
            schoolId: sid,
            isDeleted: false,
            status: { in: ['Active', 'ACTIVE', 'active'] },
        },
        include: {
            user: { select: { name: true } },
            payrollSettings: true,
            staffLoans: {
                where: { status: 'active', outstandingBalance: { gt: 0 } }
            }
        },
    });

    if (allStaff.length === 0) {
        return res.status(400).json({ success: false, message: 'No active staff found for this school. Add staff members and configure their payroll settings first.' });
    }

    // Attendance: lateness / absence deductions for the month, when the school has turned that on
    let attendanceDeductions = {};
    try {
        const { getSettings } = require('../services/attendance-core.service');
        if ((await getSettings(sid)).autoDeductInPayroll) {
            const mm = String(parseInt(month)).padStart(2, '0');
            const last = String(new Date(Date.UTC(parseInt(year), parseInt(month), 0)).getUTCDate()).padStart(2, '0');
            const grossByStaff = Object.fromEntries(allStaff.map(s => [s.id, s.payrollSettings.filter(p => p.type === 'earning').reduce((n, p) => n + p.amount, 0)]));
            attendanceDeductions = await require('../services/attendance-payroll.service').computeStaffDeductions({ schoolId: sid, from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}`, grossByStaff });
        }
    } catch (e) { console.error('[payroll] attendance deductions skipped:', e.message); }

    // Compute totals
    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    const items = allStaff.map(s => {
        const earnings = s.payrollSettings.filter(p => p.type === 'earning');
        const standardDeductions = s.payrollSettings.filter(p => p.type === 'deduction');
        
        let gross = earnings.reduce((sum, e) => sum + e.amount, 0);
        let deductionTotal = standardDeductions.reduce((sum, d) => sum + d.amount, 0);
        
        const deductionsBreakdown = standardDeductions.map(d => ({ name: d.itemName, amount: d.amount }));

        // Phase 2: Add auto-deductions for active loans
        if (s.staffLoans && s.staffLoans.length > 0) {
            s.staffLoans.forEach(loan => {
                const deduct = Math.min(loan.repaymentPerMonth, loan.outstandingBalance);
                if (deduct > 0) {
                    deductionTotal += deduct;
                    deductionsBreakdown.push({ 
                        name: `Loan Repayment`, 
                        amount: deduct,
                        loanId: loan.id // track for confirmation
                    });
                }
            });
        }

        (attendanceDeductions[s.id]?.lines || []).forEach(l => {
            if (l.amount > 0) { deductionTotal += l.amount; deductionsBreakdown.push({ name: l.name, amount: l.amount, attendance: true }); }
        });

        const net = Math.max(0, gross - deductionTotal);

        totalGross += gross;
        totalDeductions += deductionTotal;
        totalNet += net;

        return {
            staffId: s.id,
            gross,
            deductionsBreakdown,
            earningsBreakdown: earnings.map(e => ({ name: e.itemName, amount: e.amount })),
            net,
            status: 'pending',
            paymentMethod: 'pending',
        };
    });

    // Create run + items in a transaction
    const run = await prisma.$transaction(async (tx) => {
        const newRun = await tx.payrollRun.create({
            data: {
                schoolId: sid,
                month: parseInt(month),
                year: parseInt(year),
                totalGross,
                totalDeductions,
                totalNet,
                status: 'draft',
                createdBy,
            },
        });

        if (items.length > 0) {
            await tx.payrollRunItem.createMany({
                data: items.map(item => ({ ...item, payrollRunId: newRun.id })),
            });
        }

        return newRun;
    });

    // Fetch the full run with items
    const fullRun = await prisma.payrollRun.findUnique({
        where: { id: run.id },
        include: {
            items: {
                include: {
                    staff: { include: { user: { select: { name: true } } } },
                },
            },
        },
    });

    res.status(201).json({ success: true, run: fullRun });
});

/**
 * GET /payroll/run
 * List all payroll runs, latest first.
 */
const getPayrollRuns = asyncHandler(async function(req, res) {
    const sid = schoolId(req);
    const runs = await prisma.payrollRun.findMany({
        where: { schoolId: sid },
        orderBy: { createdAt: 'desc' },
        include: { items: { select: { id: true, status: true } } },
    });
    res.json({ success: true, runs });
});

/**
 * GET /payroll/run/:id
 * Full payroll run with all items and staff info.
 */
const getPayrollRun = asyncHandler(async function(req, res) {
    const { id } = req.params;
    const sid = schoolId(req);

    const run = await prisma.payrollRun.findFirst({
        where: { id, schoolId: sid },
        include: {
            items: {
                include: {
                    staff: {
                        include: {
                            user: { select: { name: true, email: true } },
                        },
                    },
                },
            },
        },
    });

    if (!run) return res.status(404).json({ success: false, message: 'Payroll run not found.' });

    // Enrich items with staff bank details
    const enriched = run.items.map(item => ({
        ...item,
        staffName: item.staff?.user?.name ?? 'Unknown',
        staffEmail: item.staff?.user?.email ?? '',
        department: item.staff?.department ?? '',
        employeeId: item.staff?.employeeId ?? '',
        bankName: item.staff?.bankName ?? '',
        accountNumber: item.staff?.accountNumber ?? '',
        accountName: item.staff?.accountName ?? '',
    }));

    res.json({ success: true, run: { ...run, items: enriched } });
});

/**
 * POST /payroll/run/:id/confirm
 * Confirms a payroll run:
 *   1. Marks all items as paid
 *   2. Creates PensionLedger entries for any "Pension" deductions
 *   3. Auto-creates an ExpenseRecord in Income & Expenses
 *   4. Updates run status to "confirmed"
 */
const confirmPayrollRun = asyncHandler(async function(req, res) {
    const { id } = req.params;
    const sid = schoolId(req);

    const run = await prisma.payrollRun.findFirst({
        where: { id, schoolId: sid },
        include: { items: true },
    });

    if (!run) return res.status(404).json({ success: false, message: 'Payroll run not found.' });
    if (run.status === 'confirmed') {
        return res.status(409).json({ success: false, message: 'This payroll run has already been confirmed.' });
    }

    // ── Pre-fetch all active loans for staff in this run (OUTSIDE transaction to avoid N+1 timeout) ──
    const staffIds = [...new Set(run.items.map(i => i.staffId))];
    const activeLoans = await prisma.staffLoan.findMany({
        where: {
            staffId: { in: staffIds },
            schoolId: sid,
            status: 'active',
            outstandingBalance: { gt: 0 },
        },
        orderBy: { dateCollected: 'asc' },
    });

    // Build in-memory lookup: staffId → [loans], loanId → loan
    const loansByStaff = {};
    const loansById = {};
    for (const loan of activeLoans) {
        if (!loansByStaff[loan.staffId]) loansByStaff[loan.staffId] = [];
        loansByStaff[loan.staffId].push({ ...loan }); // clone for mutable balance tracking
        loansById[loan.id] = loansByStaff[loan.staffId][loansByStaff[loan.staffId].length - 1];
    }

    // ── Pre-fetch or create expense category OUTSIDE transaction ────────────────
    let category = await prisma.financeCategory.findFirst({
        where: { schoolId: sid, name: 'Payroll Salaries', type: 'EXPENSE' },
    });
    if (!category) {
        category = await prisma.financeCategory.create({
            data: { schoolId: sid, name: 'Payroll Salaries', type: 'EXPENSE' },
        });
    }

    // ── Helper: parse deductionsBreakdown regardless of storage format ──────────
    function parseBreakdown(raw) {
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') { try { return JSON.parse(raw); } catch(e) { return []; } }
        return [];
    }

    // ── Build all write operations in memory before the transaction ──────────────
    const pensionEntries = [];
    const loanUpdates = [];      // { loanId, newBalance, status }
    const loanRepaymentEntries = [];

    for (const item of run.items) {
        const breakdown = parseBreakdown(item.deductionsBreakdown);

        // Pension entries
        for (const d of breakdown) {
            if (d.name?.toLowerCase().includes('pension') && d.amount > 0) {
                pensionEntries.push({
                    schoolId: sid,
                    staffId: item.staffId,
                    amount: d.amount,
                    date: new Date(),
                    payrollRunId: id,
                });
            }
        }

        // Loan repayment entries
        const loanItems = breakdown.filter(d => d.loanId || d.name?.toLowerCase().includes('loan'));
        for (const l of loanItems) {
            if (!l.amount || l.amount <= 0) continue;

            // Resolve loan from pre-fetched map (no DB call inside transaction)
            let loan = null;
            if (l.loanId && loansById[l.loanId]) {
                loan = loansById[l.loanId];
            } else if (loansByStaff[item.staffId]?.length > 0) {
                loan = loansByStaff[item.staffId][0]; // oldest active loan first
            }

            if (loan && loan.outstandingBalance > 0) {
                const deductAmt = Math.min(l.amount, loan.outstandingBalance);
                const newBalance = Math.max(0, loan.outstandingBalance - deductAmt);

                // Update in-memory balance so subsequent deductions on same loan are accurate
                loan.outstandingBalance = newBalance;

                loanUpdates.push({
                    loanId: loan.id,
                    newBalance,
                    newStatus: newBalance <= 0 ? 'cleared' : loan.status,
                });
                loanRepaymentEntries.push({
                    schoolId: sid,
                    loanId: loan.id,
                    staffId: item.staffId,
                    amount: deductAmt,
                    date: new Date(),
                    payrollRunId: id,
                    source: 'PAYROLL',
                    notes: `Payroll salary deduction — ${fmtMonthName(run.month)} ${run.year}`,
                });
            }
        }
    }

    // ── Transaction: only writes, no reads — fast & safe within 30s timeout ─────
    const confirmed = await prisma.$transaction(async (tx) => {
        // 1. Mark all run items as paid
        await tx.payrollRunItem.updateMany({
            where: { payrollRunId: id },
            data: { status: 'paid' },
        });

        // 2. Pension ledger entries
        if (pensionEntries.length > 0) {
            await tx.pensionLedger.createMany({ data: pensionEntries });
        }

        // 3. Loan balance updates + repayment ledger
        for (const u of loanUpdates) {
            await tx.staffLoan.update({
                where: { id: u.loanId },
                data: { outstandingBalance: u.newBalance, status: u.newStatus },
            });
        }
        if (loanRepaymentEntries.length > 0) {
            await tx.staffLoanRepayment.createMany({ data: loanRepaymentEntries });
        }

        // 4. Auto expense record
        const staffCount = run.items?.length || 0;
        const staffCountLabel = staffCount > 0 ? ` (${staffCount} Staff Members - Net Total)` : ' (Net Total)';
        const expenseRecord = await tx.expenseRecord.create({
            data: {
                schoolId: sid,
                categoryId: category.id,
                description: `Staff Salary Disbursement — ${fmtMonthName(run.month)} ${run.year}${staffCountLabel}`,
                amount: run.totalNet,
                date: new Date(),
                source: 'AUTO',
                referenceId: run.id,
                createdBy: req.user?.name ?? 'System',
            },
        });

        // 5. Confirm the run
        const updatedRun = await tx.payrollRun.update({
            where: { id },
            data: {
                status: 'confirmed',
                expenseRecordId: expenseRecord.id,
            },
        });

        return updatedRun;
    }, { timeout: 30000, maxWait: 10000 });

    res.json({
        success: true,
        message: `Payroll for ${fmtMonthName(run.month)} ${run.year} confirmed. Expense record auto-created.`,
        run: confirmed,
    });
});


/**
 * GET /payroll/run/:id/export
 * Generates an Excel file with staff bank payment details.
 */
const exportPayrollRun = asyncHandler(async function(req, res) {
    const { id } = req.params;
    const sid = schoolId(req);

    const run = await prisma.payrollRun.findFirst({
        where: { id, schoolId: sid },
        include: {
            items: {
                include: {
                    staff: { include: { user: { select: { name: true } } } },
                },
            },
        },
    });

    if (!run) return res.status(404).json({ success: false, message: 'Payroll run not found.' });

    // Dynamically require exceljs
    let ExcelJS;
    try {
        ExcelJS = require('exceljs');
    } catch {
        return res.status(500).json({
            success: false,
            message: 'exceljs is not installed. Run: npm install exceljs',
        });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Skooly Payroll';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Payroll Export');

    // ── Header row ──
    sheet.columns = [
        { header: 'S/N', key: 'sn', width: 6 },
        { header: 'Staff Name', key: 'name', width: 30 },
        { header: 'Employee ID', key: 'employeeId', width: 16 },
        { header: 'Bank Name', key: 'bankName', width: 22 },
        { header: 'Account Number', key: 'accountNumber', width: 20 },
        { header: 'Account Name', key: 'accountName', width: 28 },
        { header: 'Net Pay (NGN)', key: 'netPay', width: 18 },
    ];

    // Style header
    sheet.getRow(1).eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Add data rows
    run.items.forEach((item, idx) => {
        sheet.addRow({
            sn: idx + 1,
            name: item.staff?.user?.name ?? 'Unknown',
            employeeId: item.staff?.employeeId ?? '',
            bankName: item.staff?.bankName ?? 'N/A',
            accountNumber: item.staff?.accountNumber ?? 'N/A',
            accountName: item.staff?.accountName ?? 'N/A',
            netPay: item.net,
        });
    });

    // Total row
    const totalRow = sheet.addRow({
        sn: '',
        name: 'TOTAL',
        employeeId: '',
        bankName: '',
        accountNumber: '',
        accountName: '',
        netPay: run.totalNet,
    });
    totalRow.font = { bold: true };
    totalRow.getCell('netPay').numFmt = '#,##0.00';

    // Format net pay column
    sheet.getColumn('netPay').numFmt = '#,##0.00';

    const filename = `Payroll_${fmtMonthName(run.month)}_${run.year}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
});

// ─── PAYSLIP ──────────────────────────────────────────────────────────────────

/**
 * GET /payroll/payslip/:staffId/:month/:year
 * Returns payslip data for a staff member for a given period.
 */
const getPayslip = asyncHandler(async function(req, res) {
    const { staffId, month, year } = req.params;
    const sid = schoolId(req);

    // Get staff info
    const staff = await prisma.teacherProfile.findFirst({
        where: { id: staffId, schoolId: sid },
        include: { user: { select: { name: true, email: true } } },
    });
    if (!staff) return res.status(404).json({ success: false, message: 'Staff not found.' });

    // Get payroll run item for this period
    const runItem = await prisma.payrollRunItem.findFirst({
        where: {
            staffId,
            payrollRun: {
                schoolId: sid,
                month: parseInt(month),
                year: parseInt(year),
                status: 'confirmed',
            },
        },
        include: { payrollRun: true },
    });

    // Get current payroll settings (fallback if no run exists yet)
    const settings = await prisma.payrollSetting.findMany({
        where: { staffId, schoolId: sid },
        orderBy: { type: 'asc' },
    });

    const earnings = settings.filter(s => s.type === 'earning');
    const deductions = settings.filter(s => s.type === 'deduction');
    const gross = earnings.reduce((sum, e) => sum + e.amount, 0);
    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);

    // Get loan balance
    const loans = await prisma.staffLoan.findMany({
        where: { staffId, schoolId: sid, status: 'active' },
    });
    const outstandingLoan = loans.reduce((sum, l) => sum + l.outstandingBalance, 0);

    // Get pension total
    const pension = await prisma.pensionLedger.findMany({
        where: { staffId, schoolId: sid },
    });
    const totalPension = pension.reduce((sum, p) => sum + p.amount, 0);

    // School settings for header
    const schoolSettings = await prisma.schoolSettings.findFirst({
        where: { schoolId: sid },
    });

    res.json({ success: true, payslip: {
            period: { month: parseInt(month), year: parseInt(year), label: `${fmtMonthName(parseInt(month))} ${year}` },
            staff: {
                id: staff.id, name: staff.user?.name ?? 'Unknown', email: staff.user?.email ?? '',
                department: staff.department ?? '', employeeId: staff.employeeId,
                bankName: staff.bankName ?? '', accountNumber: staff.accountNumber ?? '', accountName: staff.accountName ?? '',
            },
            school: {
                name: schoolSettings?.schoolName ?? 'School', phone: schoolSettings?.phone ?? '',
                address: schoolSettings?.address ?? '', logoUrl: schoolSettings?.logoUrl ?? '',
            },
            earningsBreakdown: runItem ? (Array.isArray(runItem.earningsBreakdown) ? runItem.earningsBreakdown : []) : earnings.map(e => ({ name: e.itemName, amount: e.amount })),
            deductionsBreakdown: runItem ? (Array.isArray(runItem.deductionsBreakdown) ? runItem.deductionsBreakdown : []) : deductions.map(d => ({ name: d.itemName, amount: d.amount })),
            gross: runItem?.gross ?? gross,
            totalDeductions: runItem ? (runItem.gross - runItem.net) : totalDeductions,
            net: runItem?.net ?? (gross - totalDeductions),
            status: runItem?.status ?? 'draft',
            outstandingLoan, totalPensionAccumulated: totalPension,
        }
    });
});

// ─── STAFF SELF-SERVICE (MY PAYROLL) ─────────────────────────────────────────

/**
 * GET /payroll/me
 * Returns the logged-in staff member's complete payroll information:
 * salary structure, all confirmed payslips, pension accumulation, and loan repayment ledger.
 */
const getTeacherPayrollMe = asyncHandler(async function(req, res) {
    const userId = req.user?.userId || req.user?.id;
    const sid = schoolId(req);

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    const teacher = await prisma.teacherProfile.findFirst({
        where: { userId, schoolId: sid },
        include: { user: { select: { name: true, email: true } } }
    });

    if (!teacher) {
        return res.status(404).json({ success: false, message: 'Teacher / Staff profile not found for this account.' });
    }

    // 1. Current Payroll Settings (Earnings & Deductions)
    const settings = await prisma.payrollSetting.findMany({
        where: { staffId: teacher.id, schoolId: sid },
        orderBy: { type: 'asc' },
    });
    const earnings = settings.filter(s => s.type === 'earning');
    const deductions = settings.filter(s => s.type === 'deduction');
    const gross = earnings.reduce((sum, e) => sum + e.amount, 0);
    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);
    const net = Math.max(0, gross - totalDeductions);

    // 2. All Confirmed Payslips (PayrollRunItems)
    const payslipItems = await prisma.payrollRunItem.findMany({
        where: {
            staffId: teacher.id,
            payrollRun: {
                schoolId: sid,
                status: 'confirmed',
            }
        },
        include: {
            payrollRun: {
                select: {
                    id: true,
                    month: true,
                    year: true,
                    runDate: true,
                    status: true,
                }
            }
        },
        orderBy: {
            payrollRun: {
                runDate: 'desc'
            }
        }
    });

    const payslips = payslipItems.map(item => ({
        id: item.id,
        payrollRunId: item.payrollRunId,
        month: item.payrollRun.month,
        year: item.payrollRun.year,
        periodLabel: `${fmtMonthName(item.payrollRun.month)} ${item.payrollRun.year}`,
        runDate: item.payrollRun.runDate,
        gross: item.gross,
        earningsBreakdown: Array.isArray(item.earningsBreakdown) ? item.earningsBreakdown : [],
        deductionsBreakdown: Array.isArray(item.deductionsBreakdown) ? item.deductionsBreakdown : [],
        totalDeductions: item.gross - item.net,
        net: item.net,
        status: item.status,
    }));

    // 3. Pension Ledger
    const pensionEntries = await prisma.pensionLedger.findMany({
        where: { staffId: teacher.id, schoolId: sid },
        orderBy: { date: 'desc' },
        include: { payrollRun: { select: { month: true, year: true } } }
    });
    const totalPensionAccumulated = pensionEntries.reduce((sum, p) => sum + p.amount, 0);

    // 4. Loans & Repayments
    const loans = await prisma.staffLoan.findMany({
        where: { staffId: teacher.id, schoolId: sid },
        include: {
            repayments: {
                orderBy: { date: 'desc' },
                include: { payrollRun: { select: { month: true, year: true } } }
            }
        },
        orderBy: { createdAt: 'desc' }
    });
    const totalLoaned = loans.reduce((s, l) => s + l.loanAmount, 0);
    const totalOutstandingLoan = loans.filter(l => l.status === 'active').reduce((s, l) => s + l.outstandingBalance, 0);

    // School Settings for payslip headers
    const schoolSettings = await prisma.schoolSettings.findFirst({ where: { schoolId: sid } });

    res.json({
        success: true,
        teacher: {
            id: teacher.id,
            name: teacher.user?.name ?? 'Staff Member',
            email: teacher.user?.email ?? '',
            department: teacher.department ?? '',
            employeeId: teacher.employeeId,
            bankName: teacher.bankName ?? '',
            accountNumber: teacher.accountNumber ?? '',
            accountName: teacher.accountName ?? '',
        },
        school: {
            name: schoolSettings?.schoolName ?? 'School',
            phone: schoolSettings?.phone ?? '',
            address: schoolSettings?.address ?? '',
            logoUrl: schoolSettings?.logoUrl ?? '',
        },
        salaryStructure: {
            earnings,
            deductions,
            gross,
            totalDeductions,
            net,
        },
        payslips,
        pension: {
            totalAccumulated: totalPensionAccumulated,
            entries: pensionEntries,
        },
        loans: {
            totalLoaned,
            totalOutstanding: totalOutstandingLoan,
            list: loans,
        }
    });
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    getPayrollStaff,
    getPayrollSettings,
    createPayrollSetting,
    updatePayrollSetting,
    deletePayrollSetting,
    getStaffLoans,
    createStaffLoan,
    updateStaffLoan,
    recordLoanRepayment,
    getStaffPension,
    addAdhocPension,
    setOngoingPension,
    getSchoolPensionSummary,
    createPayrollRun,
    getPayrollRuns,
    getPayrollRun,
    confirmPayrollRun,
    exportPayrollRun,
    getPayslip,
    getTeacherPayrollMe,
};
