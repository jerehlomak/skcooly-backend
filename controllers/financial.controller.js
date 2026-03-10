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

// Fetch all student fee invoices (mocked or from db)
const getFeeInvoices = async (req, res) => {
    // We grab all active students and their latest invoice. 
    // If no invoice exists, we simulate one generated for "First Term 2024/2025"
    let students = await prisma.studentProfile.findMany({
        where: { schoolId: req.user.schoolId },
        include: {
            user: true,
            feeInvoices: true
        }
    });

    // Auto-generate missing invoices for demonstration purposes
    const processedStudents = await Promise.all(students.map(async (student) => {
        let invoice = student.feeInvoices[0];
        if (!invoice) {
            // Calculate a dummy total fee based on class level loosely
            const isSenior = student.classLevel.startsWith('SS');
            const total = isSenior ? 125000 : 101000;

            invoice = await prisma.feeInvoice.create({
                data: {
                    studentProfileId: student.id,
                    term: 'First Term',
                    year: '2024/2025',
                    totalAmount: total,
                    amountPaid: 0,
                    status: 'Unpaid'
                }
            });
        }

        return {
            id: invoice.id,
            studentId: student.id,
            admNo: student.admissionNo,
            name: student.user.name,
            classLevel: student.classLevel,
            totalFee: invoice.totalAmount,
            amountPaid: invoice.amountPaid,
            status: invoice.status.toLowerCase(), // paid, partial, unpaid
            lastPayment: invoice.lastPaymentDate ? invoice.lastPaymentDate.toISOString().split('T')[0] : null,
        };
    }));

    res.status(StatusCodes.OK).json({ fees: processedStudents });
};

const collectFee = async (req, res) => {
    const { invoiceId, amount, paymentMethod } = req.body; // paymentMethod: Cash, Flutterwave, Remita

    const invoice = await prisma.feeInvoice.findUnique({ where: { id: invoiceId }, include: { student: { include: { user: true } } } });
    if (!invoice) throw new CustomError.NotFoundError(`Invoice ${invoiceId} not found`);

    if (amount <= 0 || amount > (invoice.totalAmount - invoice.amountPaid)) {
        throw new CustomError.BadRequestError('Invalid payment amount');
    }

    // Step 1: If using a payment gateway, trigger the flow
    let paymentLink = null;
    let rrr = null;

    if (paymentMethod === 'Flutterwave') {
        const fwReq = await flutterwave.initializePayment(amount, invoice.student.user.email || 'parent@example.com', invoice.student.user.name, `FEE-${invoiceId.substring(0, 8)}`);
        paymentLink = fwReq.data.link; // The frontend would normally redirect here
    } else if (paymentMethod === 'Remita') {
        const rmReq = await remita.generateRRR(amount, invoice.student.user.name, invoice.student.user.email || 'parent@example.com', `FEE-${invoiceId.substring(0, 8)}`);
        rrr = rmReq.RRR; // The frontend would print this for the parent to take to bank
    }

    // Step 2: Since we are mocking the success flow, we instantly process the payment.
    // In production, you would await a Webhook from Flutterwave/Remita to do Step 2.

    const newPaid = invoice.amountPaid + Number(amount);
    const newStatus = newPaid >= invoice.totalAmount ? 'Paid' : 'Partial';

    const updatedInvoice = await prisma.feeInvoice.update({
        where: { id: invoiceId },
        data: {
            amountPaid: newPaid,
            status: newStatus,
            lastPaymentDate: new Date()
        }
    });

    // Automatically add to financial ledger
    await prisma.transaction.create({
        data: {
            description: `Fee Collection - ${invoice.student.user.name}`,
            category: 'Fees',
            amount: Number(amount),
            type: 'income',
            gateway: paymentMethod || 'Cash',
            reference: `FEE-${invoiceId.substring(0, 6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
            schoolId: req.user.schoolId
        }
    });

    res.status(StatusCodes.OK).json({
        msg: 'Payment processed',
        invoice: updatedInvoice,
        gatewayData: { paymentLink, rrr }
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

module.exports = {
    getTransactions,
    addTransaction,
    getFeeInvoices,
    collectFee,
    getSalaries,
    paySalary
};
