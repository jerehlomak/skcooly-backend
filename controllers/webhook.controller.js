const crypto = require('crypto');
const prisma = require('../db/prisma');
const { decrypt } = require('../utils/financeEncryption');
const { settleSuccessfulPaymentTransaction } = require('./financePayment.controller');

/**
 * Helper to settle Central Admin SaaS Subscription Invoices
 */
async function settleSubscriptionInvoice({ invoiceId, paymentMethod, transactionId, amountPaid, currency = 'NGN' }) {
    if (!invoiceId) return false;

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice || invoice.status === 'PAID') return false;

    // Mark SaaS invoice as paid
    await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'PAID' }
    });

    // Create payment record
    await prisma.payment.create({
        data: {
            invoiceId,
            schoolId: invoice.schoolId,
            paymentMethod,
            amount: amountPaid || invoice.totalAmount,
            currency: currency || invoice.currency || 'NGN',
            transactionId: String(transactionId),
            status: 'COMPLETED',
            paidAt: new Date()
        }
    });

    // Update subscription period and activate
    if (invoice.subscriptionId) {
        const sub = await prisma.schoolSubscription.findUnique({ where: { id: invoice.subscriptionId } });
        if (sub) {
            const newNextBilling = new Date(sub.nextBillingDate || new Date());
            if (sub.billingCycle === 'MONTHLY') {
                newNextBilling.setMonth(newNextBilling.getMonth() + 1);
            } else {
                newNextBilling.setFullYear(newNextBilling.getFullYear() + 1);
            }

            await prisma.schoolSubscription.update({
                where: { id: sub.id },
                data: {
                    status: 'ACTIVE',
                    nextBillingDate: newNextBilling,
                    amountPaid: (sub.amountPaid || 0) + (amountPaid || invoice.totalAmount),
                    isActive: true
                }
            });

            // Reactivate school if suspended
            await prisma.school.update({
                where: { id: sub.schoolId },
                data: {
                    status: 'ACTIVE',
                    suspendedAt: null,
                    suspendReason: null
                }
            });
        }
    }

    await prisma.billingEvent.create({
        data: {
            schoolId: invoice.schoolId,
            eventType: 'WEBHOOK_PAYMENT_SUCCESS',
            description: `Payment ${transactionId} via ${paymentMethod} succeeded for invoice ${invoice.invoiceNumber}`
        }
    }).catch(err => console.error('[BillingEvent Error]:', err.message));

    return true;
}

/**
 * Flutterwave Webhook Handler
 */
const handleFlutterwaveWebhook = async (req, res) => {
    // Return 200 immediately to prevent gateway retries
    res.status(200).json({ status: 'success', message: 'Webhook received' });

    try {
        const signature = req.headers['verif-hash'];
        const payload = req.body;

        if (!payload || !payload.data) return;

        const event = payload.event;
        const data = payload.data;
        const txRef = data.tx_ref;
        const flwId = data.id;

        // Check if this is a School Fee Payment Transaction
        if (txRef) {
            const txRecord = await prisma.paymentTransaction.findUnique({ where: { reference: txRef } });

            if (txRecord) {
                // Verify hash against school settings if configured
                const settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId: txRecord.schoolId } });
                const expectedHash = settings?.flwWebhookSecret || process.env.FLUTTERWAVE_WEBHOOK_HASH;

                if (expectedHash && signature && signature !== expectedHash) {
                    console.warn(`[Flutterwave Webhook] Signature mismatch for school ${txRecord.schoolId}`);
                    return;
                }

                if (data.status === 'successful' && (event === 'charge.completed' || !event)) {
                    await settleSuccessfulPaymentTransaction({
                        reference: txRef,
                        gatewayRef: flwId,
                        gatewayResponse: data,
                        paymentMethod: 'FLUTTERWAVE'
                    });
                }
                return;
            }
        }

        // Check if this is a Central Admin SaaS Invoice Payment
        const invoiceId = data.meta?.invoiceId || payload.data?.metadata?.invoiceId;
        if (invoiceId && (data.status === 'successful' || event === 'charge.completed')) {
            await settleSubscriptionInvoice({
                invoiceId,
                paymentMethod: 'FLUTTERWAVE',
                transactionId: flwId || txRef,
                amountPaid: data.amount,
                currency: data.currency
            });
        }
    } catch (error) {
        console.error('[Flutterwave Webhook Error]:', error);
    }
};

/**
 * Monnify Webhook Handler
 */
const handleMonnifyWebhook = async (req, res) => {
    // Always acknowledge 200 immediately
    res.status(200).json({ requestSuccessful: true, responseMessage: 'success' });

    try {
        const payload = req.body;
        const eventType = payload.eventType;
        const eventData = payload.eventData;

        if (eventType !== 'SUCCESSFUL_TRANSACTION' || !eventData) return;

        const paymentRef = eventData.paymentReference;
        const txRef = eventData.transactionReference;

        // School fee payment check
        if (paymentRef) {
            const txRecord = await prisma.paymentTransaction.findUnique({ where: { reference: paymentRef } });
            if (txRecord) {
                if (eventData.paymentStatus === 'PAID') {
                    await settleSuccessfulPaymentTransaction({
                        reference: paymentRef,
                        gatewayRef: txRef,
                        gatewayResponse: eventData,
                        paymentMethod: 'MONNIFY'
                    });
                }
                return;
            }
        }

        // Central Admin SaaS check
        const invoiceId = eventData.metaData?.invoiceId;
        if (invoiceId && eventData.paymentStatus === 'PAID') {
            await settleSubscriptionInvoice({
                invoiceId,
                paymentMethod: 'MONNIFY',
                transactionId: txRef || paymentRef,
                amountPaid: eventData.amountPaid,
                currency: eventData.currencyCode
            });
        }
    } catch (error) {
        console.error('[Monnify Webhook Error]:', error);
    }
};

/**
 * Paystack Webhook Handler (Universal for SaaS + Fee Payments)
 */
const handlePaystackWebhook = async (req, res) => {
    res.status(200).send('OK');

    try {
        let payload = req.body;
        if (Buffer.isBuffer(payload)) {
            try {
                payload = JSON.parse(payload.toString('utf8'));
            } catch (e) {
                return;
            }
        }

        const event = payload.event;
        const data = payload.data;
        const reference = data?.reference;

        if (event !== 'charge.success' || !reference) return;

        // Check if School Fee Payment
        const txRecord = await prisma.paymentTransaction.findUnique({ where: { reference } });
        if (txRecord) {
            await settleSuccessfulPaymentTransaction({
                reference,
                gatewayRef: data.id,
                gatewayResponse: data,
                paymentMethod: 'PAYSTACK'
            });
            return;
        }

        // Check if SaaS Subscription Payment
        const invoiceId = data.metadata?.invoiceId;
        if (invoiceId) {
            await settleSubscriptionInvoice({
                invoiceId,
                paymentMethod: 'PAYSTACK',
                transactionId: data.id || reference,
                amountPaid: (data.amount || 0) / 100,
                currency: data.currency
            });
        }
    } catch (error) {
        console.error('[Paystack Webhook Error]:', error);
    }
};

/**
 * Generic Webhook Handler (Backward compatibility)
 */
const handlePaymentWebhook = async (req, res) => {
    const fwHash = req.headers['verif-hash'];
    if (fwHash) {
        return handleFlutterwaveWebhook(req, res);
    }
    const signature = req.headers['x-paystack-signature'];
    if (signature) {
        return handlePaystackWebhook(req, res);
    }
    const monnifySig = req.headers['monnify-signature'];
    if (monnifySig) {
        return handleMonnifyWebhook(req, res);
    }
    return handleFlutterwaveWebhook(req, res);
};

module.exports = {
    handlePaymentWebhook,
    handleFlutterwaveWebhook,
    handleMonnifyWebhook,
    handlePaystackWebhook,
    settleSubscriptionInvoice
};
