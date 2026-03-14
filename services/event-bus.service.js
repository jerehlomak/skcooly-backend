const EventEmitter = require('events');
const prisma = require('../db/prisma');
const { redis } = require('./redis.service'); // Optional Redis hook

class DomainEventBus extends EventEmitter {}
const eventBus = new DomainEventBus();

// ─── DEFINE ALL SYSTEM EVENTS ──────────────────────────────────────────────
const EVENTS = {
    STUDENT_CREATED: 'tenant.student.created',
    STUDENT_DELETED: 'tenant.student.deleted',
    RESULT_ADDED: 'tenant.academic.result_added',
    FEE_INVOICE_PAID: 'tenant.finance.invoice_paid',
    BILLING_SUBSCRIPTION_SUSPENDED: 'central.billing.suspended',
};

// ─── CORE EVENT LISTENERS (DECOUPLED LOGIC) ────────────────────────────────
eventBus.on(EVENTS.STUDENT_CREATED, async (payload) => {
    const { schoolId, studentId, admissionNo, email } = payload;
    console.log(`[Event Bus] Student Created -> ${admissionNo}`);
    
    // Future Action: E.g., dispatching welcome email via Queue
    // emailQueue.add(...)
});

eventBus.on(EVENTS.RESULT_ADDED, async (payload) => {
    const { schoolId, studentProfileId, term, subjectId } = payload;
    console.log(`[Event Bus] Result Published -> Profile ${studentProfileId} / Term: ${term}`);
    
    // Future Action: E.g., Push Notification to Parent via Websockets
});

eventBus.on(EVENTS.FEE_INVOICE_PAID, async (payload) => {
    const { schoolId, invoiceId, amountPaid } = payload;
    console.log(`[Event Bus] Invoice Paid -> ${invoiceId} ($${amountPaid})`);
});

// ─── PUBLISHER WRAPPER ─────────────────────────────────────────────────────
const publishEvent = (eventName, payload) => {
    // In a multi-node production deployment, this could seamlessly publish to Redis:
    // if (redis) redis.publish(eventName, JSON.stringify(payload));

    // Natively emit to local listeners
    eventBus.emit(eventName, payload);
};

module.exports = {
    eventBus,
    EVENTS,
    publishEvent
};
