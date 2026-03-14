const { Queue, Worker } = require('bullmq')
const { redis } = require('./redis.service')
const prisma = require('../db/prisma')

let billingQueue = null;
let billingWorker = null;

if (redis) {
    // 1. Initialize the Queue using the shared Redis Connection
    billingQueue = new Queue('billing-cron-queue', { connection: redis });

    /**
     * 2. Define the Worker logic
     * This processes any job that lands in 'billing-cron-queue'
     */
    billingWorker = new Worker('billing-cron-queue', async (job) => {
        switch (job.name) {
            case 'daily-billing-check':
                console.log(`[BullMQ] Starting job: ${job.name} (ID: ${job.id})`);
                await processInvoiceGeneration();
                await processDunningAndSuspension();
                console.log(`[BullMQ] Finished job: ${job.name}`);
                break;

            default:
                console.warn(`[BullMQ] Unknown job name: ${job.name}`);
        }
    }, { connection: redis });
}

// Worker event listeners for logging
if (billingWorker) {
    billingWorker.on('completed', job => {
        console.log(`[BullMQ] Job ${job.id} has completed!`);
    });
    billingWorker.on('failed', (job, err) => {
        console.error(`[BullMQ] Job ${job.id} has failed with ${err.message}`);
    });
}


/**
 * 3. Schedule the recurring job (Replaces node-cron)
 * We add a repeatable job that BullMQ will trigger safely across distributed nodes 
 * and prevent duplicate runs.
 */
const startBillingCron = async () => {
    if (!billingQueue) {
        console.log('[BullMQ] Redis is disabled locally. Skipping billing cron schedule.');
        return;
    }

    // Clear any previous repeatable jobs to avoid duplicates during deployment/restart
    const repeatableJobs = await billingQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        await billingQueue.removeRepeatableByKey(job.key);
    }

    // Schedule the new daily job at 00:01
    await billingQueue.add('daily-billing-check', {}, {
        repeat: {
            pattern: '1 0 * * *' // 12:01 AM every day
        }
    });

    console.log('[BullMQ] Daily billing cron scheduled successfully');
}


// ─── CORE BILLING LOGIC FROM OLD SERVICE ─────────────────────────────────────────

const processInvoiceGeneration = async () => {
    const today = new Date()
    const threeDaysFromNow = new Date(today)
    threeDaysFromNow.setDate(today.getDate() + 3)

    // Find active subscriptions renewing in the next 3 days
    const upcomingRenewals = await prisma.schoolSubscription.findMany({
        where: {
            isActive: true,
            status: 'ACTIVE',
            nextBillingDate: { lte: threeDaysFromNow, gte: today }
        },
        include: { plan: true }
    })

    for (const sub of upcomingRenewals) {
        const existingInvoice = await prisma.invoice.findFirst({
            where: { subscriptionId: sub.id, dueDate: sub.nextBillingDate }
        })

        if (!existingInvoice && sub.plan) {
            const amount = sub.billingCycle === 'YEARLY' ? sub.plan.yearlyPrice : sub.plan.monthlyPrice

            if (amount > 0) {
                const invoice = await prisma.invoice.create({
                    data: {
                        schoolId: sub.schoolId,
                        subscriptionId: sub.id,
                        invoiceNumber: `INV-${sub.schoolId.substring(0, 4).toUpperCase()}-${Date.now().toString().slice(-6)}`,
                        amount: amount,
                        totalAmount: amount,
                        dueDate: sub.nextBillingDate,
                        status: 'DRAFT',
                        currency: 'USD'
                    }
                })

                await prisma.invoiceItem.create({
                    data: {
                        invoiceId: invoice.id,
                        description: `${sub.plan.name} Plan - ${sub.billingCycle}`,
                        quantity: 1,
                        unitPrice: amount,
                        total: amount
                    }
                })

                await prisma.billingEvent.create({
                    data: {
                        schoolId: sub.schoolId,
                        eventType: 'INVOICE_GENERATED',
                        description: `Draft invoice generated for upcoming renewal on ${sub.nextBillingDate.toISOString().split('T')[0]}`
                    }
                })
            }
        }
    }
}

const processDunningAndSuspension = async () => {
    const today = new Date()

    // Find accounts past due
    const pastDueRenewals = await prisma.schoolSubscription.findMany({
        where: { isActive: true, status: 'ACTIVE', nextBillingDate: { lt: today } }
    })

    for (const sub of pastDueRenewals) {
        await prisma.schoolSubscription.update({
            where: { id: sub.id },
            data: { status: 'PAST_DUE' }
        })

        await prisma.invoice.updateMany({
            where: { subscriptionId: sub.id, status: 'DRAFT', dueDate: sub.nextBillingDate },
            data: { status: 'OPEN' }
        })

        await prisma.billingEvent.create({
            data: {
                schoolId: sub.schoolId,
                eventType: 'SUBSCRIPTION_PAST_DUE',
                description: 'Subscription marked as PAST_DUE. Payment is required.'
            }
        })
    }

    // Suspend accounts that are 14 days PAST_DUE
    const fourteenDaysAgo = new Date(today); fourteenDaysAgo.setDate(today.getDate() - 14)
    const accountsToSuspend = await prisma.schoolSubscription.findMany({
        where: { isActive: true, status: 'PAST_DUE', nextBillingDate: { lte: fourteenDaysAgo } }
    })

    for (const sub of accountsToSuspend) {
        await prisma.schoolSubscription.update({
            where: { id: sub.id },
            data: { status: 'SUSPENDED', isActive: false, suspendedAt: new Date() }
        })

        await prisma.school.update({
            where: { id: sub.schoolId },
            data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendReason: 'Billing - 14 Days Past Due' }
        })

        await prisma.billingEvent.create({
            data: { schoolId: sub.schoolId, eventType: 'SUBSCRIPTION_SUSPENDED', description: 'School account suspended due to unpaid invoices exceeding 14 days.' }
        })
    }
}

module.exports = { startBillingCron }
