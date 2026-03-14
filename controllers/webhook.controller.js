const prisma = require('../db/prisma')

// Generic Webhook Handler (Stripe, Paystack, Flutterwave)
// Since this is a placeholder implementation for the architecture, we verify standard fields.
const handlePaymentWebhook = async (req, res) => {
    // ─── WEBHOOK VERIFICATION ───────────────────────────────────────────────
    const fwHash = req.headers['verif-hash'];
    const expectedFwHash = process.env.FLUTTERWAVE_WEBHOOK_HASH;

    // If an environment secret is configured, enforce strict verification
    if (expectedFwHash && (!fwHash || fwHash !== expectedFwHash)) {
        console.warn('Unauthorized webhook attempt detected');
        return res.status(401).send('Unauthorized webhook payload');
    }
    // ────────────────────────────────────────────────────────────────────────
    const payload = req.body

    try {
        // e.g., standardizing the payload from different providers
        const eventType = payload.event || payload.type // 'charge.success', 'invoice.paid'
        const data = payload.data?.object || payload.data

        if (eventType === 'charge.success' || eventType === 'invoice.payment_succeeded') {
            const transactionId = data.id || data.reference
            const amount = data.amount / 100 // assuming amounts come in cents/kobo
            const invoiceId = data.metadata?.invoiceId // Assuming we pass invoiceId in payment metadata

            if (invoiceId) {
                const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })

                if (invoice && invoice.status !== 'PAID') {
                    // Mark invoice as paid
                    await prisma.invoice.update({
                        where: { id: invoiceId },
                        data: { status: 'PAID' }
                    })

                    // Create Payment record
                    await prisma.payment.create({
                        data: {
                            invoiceId: invoiceId,
                            schoolId: invoice.schoolId,
                            paymentMethod: payload.event ? 'PAYSTACK' : 'STRIPE', // naive check
                            amount: invoice.totalAmount, // or pulled from webhook
                            currency: invoice.currency,
                            transactionId: transactionId.toString(),
                            status: 'COMPLETED',
                            paidAt: new Date()
                        }
                    })

                    // Extend subscription
                    const sub = await prisma.schoolSubscription.findUnique({
                        where: { id: invoice.subscriptionId }
                    })

                    if (sub) {
                        const newNextBilling = new Date(sub.nextBillingDate || new Date())
                        if (sub.billingCycle === 'MONTHLY') {
                            newNextBilling.setMonth(newNextBilling.getMonth() + 1)
                        } else {
                            newNextBilling.setFullYear(newNextBilling.getFullYear() + 1)
                        }

                        await prisma.schoolSubscription.update({
                            where: { id: sub.id },
                            data: {
                                status: 'ACTIVE',
                                nextBillingDate: newNextBilling,
                                amountPaid: sub.amountPaid + invoice.totalAmount,
                                isActive: true
                            }
                        })

                        // Reactivate school if it was suspended
                        await prisma.school.update({
                            where: { id: sub.schoolId },
                            data: {
                                status: 'ACTIVE',
                                suspendedAt: null,
                                suspendReason: null
                            }
                        })
                    }

                    await prisma.billingEvent.create({
                        data: {
                            schoolId: invoice.schoolId,
                            eventType: 'WEBHOOK_PAYMENT_SUCCESS',
                            description: `Payment ${transactionId} succeeded for invoice ${invoice.invoiceNumber}`
                        }
                    })
                }
            }
        }

        res.status(200).send('Webhook Received')
    } catch (error) {
        console.error('Webhook processing error:', error)
        res.status(500).send('Internal Server Error')
    }
}

module.exports = { handlePaymentWebhook }
