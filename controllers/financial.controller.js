const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const flutterwave = require('../utils/flutterwave');
const remita = require('../utils/remita');
const crypto = require('crypto');

// ─── ACCOUNTS & TRANSACTIONS (LEDGER) ────────────────────────────────────────

const getTransactions = async (req, res) => {
    const transactions = await prisma.transaction.findMany({
        where: { schoolId: req.user.schoolId },
        orderBy: { date: 'desc' },
    });

    // Calculate simple KPIs
    const income = transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
    const expense = transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);

    res.status(StatusCodes.OK).json({
        transactions,
        kpis: { income, expense, balance: income - expense }
    });
};

const getFinanceAnalytics = async (req, res) => {
    // Analytics for the admin dashboard: total grouped by Term/Year
    const invoices = await prisma.feeInvoice.findMany({
        where: { schoolId: req.user.schoolId, isDeleted: false },
        include: { student: { include: { classArm: true } } }
    });

    const totalBilled = invoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const totalCollected = invoices.reduce((sum, inv) => sum + inv.amountPaid, 0);
    const totalOutstanding = totalBilled - totalCollected;

    // Group revenue by term
    const revenueByTerm = invoices.reduce((acc, inv) => {
        const key = `${inv.term} ${inv.year}`;
        if (!acc[key]) acc[key] = { billed: 0, collected: 0 };
        acc[key].billed += inv.totalAmount;
        acc[key].collected += inv.amountPaid;
        return acc;
    }, {});

    // Group revenue by class
    const revenueByClass = invoices.reduce((acc, inv) => {
        const className = inv.student?.classArm?.name || 'Unassigned';
        if (!acc[className]) acc[className] = { billed: 0, collected: 0 };
        acc[className].billed += inv.totalAmount;
        acc[className].collected += inv.amountPaid;
        return acc;
    }, {});

    res.status(StatusCodes.OK).json({
        kpis: { totalBilled, totalCollected, totalOutstanding },
        revenueByTerm,
        revenueByClass
    });
};

const addTransaction = async (req, res) => {
    const { description, category, amount, type, gateway } = req.body;

    if (!description || !amount || !type) {
        throw new CustomError.BadRequestError('Please provide description, amount and type');
    }

    const ref = `${type === 'income' ? 'INC' : 'EXP'}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const transaction = await prisma.transaction.create({
        data: {
            description,
            category: category || 'General',
            amount: Number(amount),
            type,
            reference: ref,
            gateway: gateway || 'Manual',
            date: new Date(),
            schoolId: req.user.schoolId
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Transaction added', transaction });
};

// ─── FEES COLLECTION ────────────────────────────────────────────────────────

const getFeeInvoices = async (req, res) => {
    const { term, year, classId, status } = req.query;

    let whereClause = { schoolId: req.user.schoolId };
    if (term) whereClause.term = term;
    if (year) whereClause.year = year;
    if (status) whereClause.status = status;
    
    // To filter by classId, we have to look up the student relation
    if (classId) {
        whereClause.student = { classId };
    }

    const invoices = await prisma.feeInvoice.findMany({
        where: whereClause,
        include: {
            student: {
                select: {
                    id: true,
                    admissionNo: true,
                    classLevel: true,
                    user: { select: { name: true } }
                }
            }
        },
        orderBy: { createdAt: 'desc' }
    });

    const formatted = invoices.map(invoice => ({
        id: invoice.id,
        studentId: invoice.studentProfileId,
        admNo: invoice.student.admissionNo,
        name: invoice.student.user?.name,
        classLevel: invoice.student.classLevel,
        term: invoice.term,
        year: invoice.year,
        totalFee: invoice.totalAmount,
        amountPaid: invoice.amountPaid,
        status: invoice.status.toLowerCase(), // paid, partial, unpaid
        lastPayment: invoice.lastPaymentDate ? invoice.lastPaymentDate.toISOString().split('T')[0] : null,
        dueDate: invoice.dueDate ? invoice.dueDate.toISOString().split('T')[0] : null
    }));

    res.status(StatusCodes.OK).json({ fees: formatted, count: formatted.length });
};

const generateBulkInvoices = async (req, res) => {
    const { classId, term, year, totalAmount, dueDate } = req.body;

    if (!classId || !term || !year || !totalAmount) {
        throw new CustomError.BadRequestError('Please provide classId, term, year, and totalAmount');
    }

    // Find all active students in the selected class
    const students = await prisma.studentProfile.findMany({
        where: { schoolId: req.user.schoolId, classId, status: 'Active' }
    });

    if (students.length === 0) {
        return res.status(StatusCodes.OK).json({ msg: 'No active students found in this class', count: 0 });
    }

    let createdCount = 0;
    
    // Create an invoice for each student if one doesn't already exist for the term/year
    for (const student of students) {
        const existingInvoice = await prisma.feeInvoice.findFirst({
            where: {
                studentProfileId: student.id,
                term,
                year
            }
        });

        if (!existingInvoice) {
            await prisma.feeInvoice.create({
                data: {
                    schoolId: req.user.schoolId,
                    studentProfileId: student.id,
                    term,
                    year,
                    totalAmount: Number(totalAmount),
                    dueDate: dueDate ? new Date(dueDate) : null,
                    amountPaid: 0,
                    status: 'Unpaid'
                }
            });
            createdCount++;
        }
    }

    res.status(StatusCodes.CREATED).json({ msg: `Successfully generated ${createdCount} invoices.`, count: createdCount });
};

const collectFee = async (req, res) => {
    const { invoiceId, amount, paymentMethod } = req.body; // paymentMethod: Cash, Flutterwave, Remita

    const invoice = await prisma.feeInvoice.findUnique({ where: { id: invoiceId }, include: { student: { include: { user: true } } } });
    if (!invoice) throw new CustomError.NotFoundError(`Invoice ${invoiceId} not found`);

    if (amount <= 0 || amount > (invoice.totalAmount - invoice.amountPaid)) {
        throw new CustomError.BadRequestError('Invalid payment amount');
    }

    // Store the installment as a manual cash payment locally or trigger a webhook.
    // In production, parent UI hits a different route like /payments/initialize
    // so this is strictly the Bursar's manual entry panel endpoint.

    // Use a transaction to securely update balances and logs
    const result = await prisma.$transaction(async (tx) => {
        const newPaid = invoice.amountPaid + Number(amount);
        const newStatus = newPaid >= invoice.totalAmount ? 'Paid' : 'Partial';

        const updatedInvoice = await tx.feeInvoice.update({
            where: { id: invoiceId },
            data: {
                amountPaid: newPaid,
                status: newStatus,
                lastPaymentDate: new Date()
            }
        });

        // Automatically add to school-level transaction
        const schoolTx = await tx.transaction.create({
            data: {
                description: `Fee Collection - ${invoice.student.user.name}`,
                category: 'Fees',
                amount: Number(amount),
                type: 'income',
                gateway: paymentMethod || 'Cash',
                reference: `FEE-${invoiceId.substring(0, 6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
                schoolId: req.user.schoolId,
                feeInvoiceId: invoice.id,
                studentProfileId: invoice.student.id
            }
        });

        // Generate Student Ledger Entry (CREDIT)
        const lastLedger = await tx.studentLedger.findFirst({
            where: { studentProfileId: invoice.student.id },
            orderBy: { createdAt: 'desc' }
        });
        const currentBalance = lastLedger ? lastLedger.balanceAfter : 0;
        
        await tx.studentLedger.create({
            data: {
                schoolId: invoice.schoolId,
                studentProfileId: invoice.student.id,
                type: 'CREDIT',
                category: 'Payment',
                description: `Manual Payment (${paymentMethod || 'Cash'})`,
                amount: Number(amount),
                balanceAfter: currentBalance - Number(amount), // Credit decreases debt balance
                feeInvoiceId: invoice.id,
                transactionId: schoolTx.id
            }
        });
        
        return updatedInvoice;
    });

    res.status(StatusCodes.OK).json({
        msg: 'Payment processed',
        invoice: result
    });
};

// ─── SALARY / PAYROLL ────────────────────────────────────────────────────────

const getSalaries = async (req, res) => {
    // Generate/fetch salary slips for active teachers
    const teachers = await prisma.teacherProfile.findMany({
        where: { schoolId: req.user.schoolId },
        include: { user: true, salarySlips: true }
    });

    // Use current month/year, e.g. "March 2025"
    const currentPeriod = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

    const payroll = await Promise.all(teachers.map(async (teacher) => {
        let slip = teacher.salarySlips.find(s => s.payPeriod === currentPeriod);

        if (!slip) {
            // Generate slip
            const basic = teacher.salary || 150000;
            const allowance = 30000;
            const deduction = 15000;

            slip = await prisma.salarySlip.create({
                data: {
                    teacherProfileId: teacher.id,
                    payPeriod: currentPeriod,
                    basic, allowance, deduction,
                    netPay: basic + allowance - deduction,
                    status: 'Pending'
                }
            });
        }

        return {
            id: slip.id,
            teacherId: teacher.id,
            name: teacher.user.name,
            role: teacher.department || 'Teacher',
            department: teacher.department || 'Academics',
            basic: slip.basic,
            allowance: slip.allowance,
            deduction: slip.deduction,
            status: slip.status.toLowerCase(), // paid, pending
            payPeriod: slip.payPeriod,
            bankName: teacher.bankName || 'N/A',
            accountNumber: teacher.accountNumber || 'Pending Details',
        };
    }));

    res.status(StatusCodes.OK).json({ payroll });
};

const paySalary = async (req, res) => {
    const { slipId, gateway } = req.body; // gateway = 'Flutterwave' or 'Remita' or 'Cash'

    const slip = await prisma.salarySlip.findUnique({ where: { id: slipId }, include: { teacher: true } });
    if (!slip) throw new CustomError.NotFoundError('Salary slip not found');
    if (slip.status === 'Paid') throw new CustomError.BadRequestError('Salary already paid for this period');

    // 1. Simulate gateway Payout logic
    let ref = `SAL-${slipId.substring(0, 8)}`;
    if (gateway === 'Flutterwave') {
        const fw = await flutterwave.initiateTransfer(slip.netPay, slip.teacher.bankName || '044', slip.teacher.accountNumber || '0000000000', `Salary ${slip.payPeriod}`);
        ref = fw.data.reference;
    } else if (gateway === 'Remita') {
        const rm = await remita.singlePayment(slip.netPay, 'YOUR_DEBIT_ACCOUNT', slip.teacher.accountNumber || '0000000000', slip.teacher.bankName || '044', `Salary ${slip.payPeriod}`);
        ref = rm.data.transRef;
    } else {
        ref = `SAL-MANUAL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    }

    // 2. Mark slip as Paid
    const updatedSlip = await prisma.salarySlip.update({
        where: { id: slipId },
        data: {
            status: 'Paid',
            paymentReference: ref,
            paymentDate: new Date()
        }
    });

    // 3. Register Ledger Expense
    await prisma.transaction.create({
        data: {
            description: `Staff Salary (${slip.payPeriod})`,
            category: 'Salaries',
            amount: slip.netPay,
            type: 'expense',
            reference: ref,
            gateway: gateway || 'Cash',
            schoolId: req.user.schoolId
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Salary paid via ' + (gateway || 'Cash'), slip: updatedSlip });
};

// ─── GET MY INVOICES (STUDENT/PARENT) ───────────────────────────────────────
const getMyInvoices = async (req, res) => {
    try {
        let targetProfileIds = [];

        if (req.user.role === 'STUDENT') {
            const student = await prisma.studentProfile.findUnique({
                where: { userId: req.user.userId }
            });
            if (!student) throw new CustomError.NotFoundError('Student profile not found');
            targetProfileIds.push(student.id);
        } else if (req.user.role === 'PARENT') {
            const parent = await prisma.parentProfile.findUnique({
                where: { userId: req.user.userId },
                include: { students: true }
            });
            if (!parent) throw new CustomError.NotFoundError('Parent profile not found');
            targetProfileIds = parent.students.map(c => c.id);
        } else {
            throw new CustomError.UnauthorizedError('Only Students and Parents can access this endpoint directly');
        }

        if (targetProfileIds.length === 0) {
            return res.status(StatusCodes.OK).json({ fees: [] });
        }

        const invoices = await prisma.feeInvoice.findMany({
            where: {
                schoolId: req.user.schoolId,
                studentProfileId: { in: targetProfileIds }
            },
            include: {
                items: true,
                ledgerEntries: { orderBy: { createdAt: 'desc' } },
                student: {
                    select: {
                        admissionNo: true,
                        classLevel: true,
                        user: { select: { name: true } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        const formatted = invoices.map(invoice => ({
            id: invoice.id,
            studentId: invoice.studentProfileId,
            admNo: invoice.student.admissionNo,
            name: invoice.student.user.name,
            classLevel: invoice.student.classLevel,
            totalFee: invoice.totalAmount,
            amountPaid: invoice.amountPaid,
            status: invoice.status ? invoice.status.toLowerCase() : 'unpaid',
            lastPayment: invoice.lastPaymentDate ? invoice.lastPaymentDate.toISOString().split('T')[0] : null,
            term: invoice.term,
            year: invoice.year,
            items: invoice.items,
            ledgerEntries: invoice.ledgerEntries
        }));

        res.status(StatusCodes.OK).json({ fees: formatted });
    } catch (error) {
        require('fs').writeFileSync('debug-error.txt', error.stack || error.message);
        console.error("CRITICAL ERROR IN getMyInvoices:", error);
        res.status(500).json({ msg: error.message, stack: error.stack });
    }
};

module.exports = {
    getTransactions,
    addTransaction,
    getFeeInvoices,
    generateBulkInvoices,
    collectFee,
    getSalaries,
    paySalary,
    getMyInvoices,
    getFinanceAnalytics
};
