const prisma = require('../db/prisma');
const CustomError = require('../errors');
const { StatusCodes } = require('http-status-codes');

// Helper to get studentId from logged-in user
const getStudentId = async (userId) => {
    const student = await prisma.studentProfile.findUnique({
        where: { userId }
    });
    if (!student) {
        throw new CustomError.NotFoundError('Student profile not found for this user');
    }
    return student.id;
};

const getMyWallet = async (req, res) => {
    const { userId, schoolId } = req.user;
    const studentId = await getStudentId(userId);

    let wallet = await prisma.studentWallet.findUnique({
        where: { studentId }
    });

    if (!wallet) {
        // Create an empty wallet if it doesn't exist
        const student = await prisma.studentProfile.findUnique({ where: { id: studentId } });
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

const getMyInvoices = async (req, res) => {
    const { userId, schoolId } = req.user;
    const studentId = await getStudentId(userId);

    const invoices = await prisma.financeInvoice.findMany({
        where: { 
            studentId, 
            schoolId, 
            isDeleted: false 
        },
        include: {
            items: true
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ invoices, count: invoices.length });
};

const getMyPayments = async (req, res) => {
    const { userId, schoolId } = req.user;
    const studentId = await getStudentId(userId);

    const payments = await prisma.paymentTransaction.findMany({
        where: {
            studentId,
            schoolId,
            status: 'SUCCESSFUL'
        },
        include: {
            receipt: { select: { receiptNumber: true } }
        },
        orderBy: { paidAt: 'desc' },
        take: 100
    });

    res.status(StatusCodes.OK).json({ payments, count: payments.length });
};

module.exports = {
    getMyWallet,
    getMyInvoices,
    getMyPayments
};
