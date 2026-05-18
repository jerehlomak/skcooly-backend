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
        orderBy: { createdAt: 'desc' },
    });

    const totalLoaned = loans.reduce((s, l) => s + l.loanAmount, 0);
    const totalOutstanding = loans
        .filter(l => l.status === 'active')
        .reduce((s, l) => s + l.outstandingBalance, 0);

    res.json({ success: true, loans, totalLoaned, totalOutstanding });
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

    // Fetch all active staff with their payroll settings
    const allStaff = await prisma.teacherProfile.findMany({
        where: {
            schoolId: sid,
            isDeleted: false,
            status: { in: ['Active', 'ACTIVE', 'active'] },
        },
        include: {
            user: { select: { name: true } },
            payrollSettings: true,
        },
    });

    if (allStaff.length === 0) {
        return res.status(400).json({ success: false, message: 'No active staff found for this school. Add staff members and configure their payroll settings first.' });
    }

    // Compute totals
    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    const items = allStaff.map(s => {
        const earnings = s.payrollSettings.filter(p => p.type === 'earning');
        const deductions = s.payrollSettings.filter(p => p.type === 'deduction');
        const gross = earnings.reduce((sum, e) => sum + e.amount, 0);
        const deductionTotal = deductions.reduce((sum, d) => sum + d.amount, 0);
        const net = Math.max(0, gross - deductionTotal);

        totalGross += gross;
        totalDeductions += deductionTotal;
        totalNet += net;

        return {
            staffId: s.id,
            gross,
            deductionsBreakdown: deductions.map(d => ({ name: d.itemName, amount: d.amount })),
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

    // ── Transaction ───────────────────────────────────────────────────────────
    const confirmed = await prisma.$transaction(async (tx) => {
        // 1. Mark all run items as paid
        await tx.payrollRunItem.updateMany({
            where: { payrollRunId: id },
            data: { status: 'paid' },
        });

        // 2. Create PensionLedger entries for pension deductions
        const pensionEntries = [];
        for (const item of run.items) {
            const breakdown = Array.isArray(item.deductionsBreakdown) ? item.deductionsBreakdown : [];
            const pensionItems = breakdown.filter(d =>
                d.name?.toLowerCase().includes('pension')
            );
            for (const p of pensionItems) {
                pensionEntries.push({
                    schoolId: sid,
                    staffId: item.staffId,
                    amount: p.amount,
                    date: new Date(),
                    payrollRunId: id,
                });
            }
        }
        if (pensionEntries.length > 0) {
            await tx.pensionLedger.createMany({ data: pensionEntries });
        }

        // 3. Find or create a "Payroll Salaries" Expense category
        let category = await tx.financeCategory.findFirst({
            where: { schoolId: sid, name: 'Payroll Salaries', type: 'EXPENSE' },
        });
        if (!category) {
            category = await tx.financeCategory.create({
                data: { schoolId: sid, name: 'Payroll Salaries', type: 'EXPENSE' },
            });
        }

        // 4. Create the auto ExpenseRecord
        const expenseRecord = await tx.expenseRecord.create({
            data: {
                schoolId: sid,
                categoryId: category.id,
                description: `Payroll — ${fmtMonthName(run.month)} ${run.year}`,
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
    });

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
    getStaffPension,
    createPayrollRun,
    getPayrollRuns,
    getPayrollRun,
    confirmPayrollRun,
    exportPayrollRun,
    getPayslip,
};
