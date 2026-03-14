const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');
const flutterwave = require('../utils/flutterwave');
const remita = require('../utils/remita');
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const crypto = require('crypto');

const initializePayment = async (req, res) => {
    const { invoiceId, amount, gateway } = req.body;
    
    if (!invoiceId || !amount || !gateway) {
        throw new CustomError.BadRequestError('Missing payment details');
    }

    const invoice = await prisma.feeInvoice.findUnique({
        where: { id: invoiceId },
        include: { student: { include: { user: true } } }
    });

    if (!invoice) throw new CustomError.NotFoundError(`Invoice not found`);
    if (amount <= 0 || amount > (invoice.totalAmount - invoice.amountPaid)) {
        throw new CustomError.BadRequestError('Invalid payment amount');
    }

    let checkoutUrl = null;
    let rrr = null;
    const txRef = `FEE-${invoiceId.substring(0, 8)}-${crypto.randomBytes(4).toString('hex')}`;

    if (gateway === 'Stripe') {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: `School Fee - ${invoice.term} ${invoice.year}` },
                    unit_amount: amount * 100,
                },
                quantity: 1,
            }],
            mode: 'payment',
            client_reference_id: txRef,
            metadata: {
                invoiceId: invoice.id,
                schoolId: req.user.schoolId
            },
            success_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/parent/fees/success?invoiceId=${invoiceId}&gateway=Stripe`,
            cancel_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/parent/fees/cancel`,
        });
        checkoutUrl = session.url;

    } else if (gateway === 'Flutterwave') {
        const fwReq = await flutterwave.initializePayment(amount, invoice.student.user.email || 'parent@example.com', invoice.student.user.name, txRef);
        checkoutUrl = fwReq.data.link;

    } else if (gateway === 'Remita') {
        const rmReq = await remita.generateRRR(amount, invoice.student.user.name, invoice.student.user.email || 'parent@example.com', txRef);
        rrr = rmReq.RRR;
        // Remita typically has a hosted gateway link too
        checkoutUrl = `https://mock-remita.test/pay/${rrr}`;
    } else {
        throw new CustomError.BadRequestError('Invalid gateway');
    }

    // Log the initiation intent
    await prisma.feePaymentInstallment.create({
        data: {
            schoolId: req.user.schoolId,
            feeInvoiceId: invoice.id,
            amountPaid: amount,
            gateway,
            transactionRef: txRef,
            status: 'Pending'
        }
    });

    res.status(StatusCodes.OK).json({ checkoutUrl, rrr, txRef });
};

const handleWebhook = async (req, res) => {
    const { gateway } = req.params;
    const payload = req.body;

    // Log the raw gateway event
    await prisma.gatewayLog.create({
        data: {
            schoolId: req.body?.data?.metadata?.schoolId || null,
            event: req.body?.type || 'webhook_event',
            payload: payload
        }
    });

    if (gateway === 'stripe') {
        const event = req.body; // In production, verify signature: stripe.webhooks.constructEvent
        
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const txRef = session.client_reference_id;
            const invoiceId = session.metadata.invoiceId;
            const amount = session.amount_total / 100;

            await processSuccessfulPayment(txRef, invoiceId, amount, 'Stripe');
        }
    } else if (gateway === 'flutterwave') {
        // Mock FW webhook handler
        if (payload.status === 'successful') {
            // ... pseudo logic
        }
    } else if (gateway === 'remita') {
        // Mock Remita webhook handler
    }

    res.status(StatusCodes.OK).json({ received: true });
};

// Internal utility to complete payment post-webhook
async function processSuccessfulPayment(txRef, invoiceId, amount, gateway) {
    const invoice = await prisma.feeInvoice.findUnique({ where: { id: invoiceId }, include: { student: { include: { user: true } } } });
    if (!invoice) return;

    // Use a transaction to securely update balances and logs
    await prisma.$transaction(async (tx) => {
        // 1. Update Installment status
        const installment = await tx.feePaymentInstallment.update({
            where: { transactionRef: txRef },
            data: { status: 'Completed', paymentDate: new Date() }
        });

        const newPaid = invoice.amountPaid + amount;
        const newStatus = newPaid >= invoice.totalAmount ? 'Paid' : 'Partial';

        // 2. Update Invoice
        await tx.feeInvoice.update({
            where: { id: invoiceId },
            data: {
                amountPaid: newPaid,
                status: newStatus,
                lastPaymentDate: new Date()
            }
        });

        // 3. Generate School-level Transaction (Income)
        const schoolTransaction = await tx.transaction.create({
            data: {
                schoolId: invoice.schoolId,
                description: `Fee Collection (Online via ${gateway}) - ${invoice.student.user.name}`,
                category: 'Fees',
                amount: amount,
                type: 'income',
                gateway,
                reference: txRef,
                feeInvoiceId: invoice.id,
                studentProfileId: invoice.student.id
            }
        });

        // 4. Generate Student Ledger Entry (CREDIT)
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
                description: `Payment via ${gateway} (Ref: ${txRef})`,
                amount: amount,
                balanceAfter: currentBalance - amount, // Credit decreases the outstanding debt balance
                feeInvoiceId: invoice.id,
                transactionId: schoolTransaction.id,
                installmentId: installment.id
            }
        });
    });
}

const getInstallments = async (req, res) => {
    const { invoiceId } = req.params;
    const installments = await prisma.feePaymentInstallment.findMany({
        where: { feeInvoiceId: invoiceId, schoolId: req.user.schoolId },
        orderBy: { createdAt: 'desc' }
    });
    res.status(StatusCodes.OK).json({ installments });
};

module.exports = {
    initializePayment,
    handleWebhook,
    getInstallments
};
