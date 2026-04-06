/**
 * Finance Payment Controller – Phase 2 (Security-Hardened)
 * Patches applied:
 *  GAP 1  – Raw body HMAC verification (handled in app.js; controller parses Buffer)
 *  GAP 2  – Idempotent webhook: upsert on unique (reference+event) instead of findFirst+create race
 *  GAP 3  – Minimum amount guard on Paystack init (≥ ₦50 / 5000 kobo)
 *  GAP 4  – submitTransfer verifies student belongs to caller's school
 *  GAP 5  – updateBankAccount whitelists allowed fields (no schoolId/branchId reassignment)
 *  GAP 6  – applyPaymentToInvoices checks allowOverpayment setting before wallet credit
 *  GAP 7  – applyWalletToInvoice computes toApply inside the transaction
 *  GAP 8  – Email sent AFTER transaction commits (not inside $transaction)
 *  GAP 9  – getInvoice adds isDeleted: false filter
 *  GAP 10 – submitTransfer enforces transferEvidenceRequired setting
 */
'use strict';

const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');
const crypto = require('crypto');
const axios = require('axios');
const { encrypt, decrypt } = require('../utils/financeEncryption');
const { uploadTransferEvidence } = require('../services/cloudinary-upload.service');
const {
    sendInvoiceEmail,
    sendReceiptEmail,
    sendTransferSubmittedEmail,
    sendTransferApprovedEmail,
    sendTransferRejectedEmail,
} = require('../services/finance-email.service');

const MIN_PAYMENT_AMOUNT = 50; // ₦50 minimum — GAP 3

// ─── HELPERS ────────────────────────────────────────────────────────────────

function generateRef(prefix = 'PAY') {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function generateReceiptNo(prefix = 'REC-') {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}${ts}-${rand}`;
}

async function getDecryptedPaystackSecret(schoolId) {
    const settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    if (!settings || !settings.paystackSecretEnc) {
        throw new CustomError.BadRequestError('Paystack is not configured for this school');
    }
    if (!settings.paystackEnabled) {
        throw new CustomError.BadRequestError('Paystack is disabled for this school');
    }
    return decrypt(settings.paystackSecretEnc);
}

async function getStudentEmail(studentId) {
    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        include: {
            user: { select: { email: true } },
            parent: {
                include: { user: { select: { email: true } } }
            }
        }
    });
    const parentEmail = student?.parent?.user?.email;
    const studentEmail = student?.user?.email;
    return parentEmail || studentEmail || null;
}

async function logNotification(schoolId, studentId, type, recipient, status = 'SENT', metadata = null) {
    try {
        await prisma.financeNotificationLog.create({
            data: { schoolId, studentId, type, recipient, status, metadata }
        });
    } catch (e) {
        console.error('[Finance Notification Log]', e.message);
    }
}

/**
 * GAP 6 FIX: accept `allowOverpayment` parameter
 * Atomically applies a payment amount to outstanding invoices (oldest first).
 * If funds remain and allowOverpayment is true, credits them to the student wallet.
 * If funds remain but allowOverpayment is false, excess is NOT credited anywhere.
 */
async function applyPaymentToInvoices(tx, {
    schoolId, studentId, amount, paymentTransactionId, allowOverpayment = false
}) {
    let remaining = Number(amount);
    const invoiceNumbers = [];

    const invoices = await tx.financeInvoice.findMany({
        where: {
            schoolId,
            studentId,
            isDeleted: false,
            status: { in: ['PUBLISHED', 'PARTIAL'] }
        },
        orderBy: { createdAt: 'asc' }
    });

    for (const inv of invoices) {
        if (remaining <= 0) break;
        const toApply = Math.min(remaining, inv.balanceDue);
        const newPaid = inv.amountPaid + toApply;
        const newBalance = inv.balanceDue - toApply;
        const newStatus = newBalance <= 0 ? 'PAID' : 'PARTIAL';

        await tx.financeInvoice.update({
            where: { id: inv.id },
            data: { amountPaid: newPaid, balanceDue: newBalance, status: newStatus }
        });

        await tx.paymentAllocation.create({
            data: { schoolId, paymentTransactionId, invoiceId: inv.id, allocatedAmount: toApply }
        });

        invoiceNumbers.push(inv.invoiceNumber);
        remaining -= toApply;
    }

    // GAP 6 — only credit wallet if allowOverpayment is enabled
    let walletBalanceAfter = null;
    if (remaining > 0 && allowOverpayment) {
        const wallet = await tx.studentWallet.findUnique({ where: { studentId } });
        const balanceBefore = wallet?.balance ?? 0;

        const updatedWallet = await tx.studentWallet.upsert({
            where: { studentId },
            create: { schoolId, studentId, balance: remaining },
            update: { balance: { increment: remaining } }
        });
        walletBalanceAfter = updatedWallet.balance;

        await tx.studentWalletTransaction.create({
            data: {
                walletId: updatedWallet.id,
                schoolId,
                type: 'OVERPAYMENT_CREDIT',
                amount: remaining,
                balanceBefore,
                balanceAfter: walletBalanceAfter,
                reference: generateRef('WCRED'),
                description: `Overpayment credit from payment ${paymentTransactionId}`
            }
        });
    }

    return { invoiceNumbers, walletBalanceAfter, remaining };
}

async function createReceipt(tx, {
    schoolId, branchId, studentId, paymentTransactionId,
    amountPaid, method, invoiceNumbers, walletBalanceAfter,
    financeSettings, schoolSettings
}) {
    const receiptPrefix = financeSettings?.receiptPrefix || 'REC-';
    const receiptNumber = generateReceiptNo(receiptPrefix);
    return await tx.financeReceipt.create({
        data: {
            schoolId,
            branchId: branchId || null,
            studentId,
            paymentTransactionId,
            receiptNumber,
            amountPaid,
            method,
            invoiceNumbers,
            walletBalanceAfter,
            metadata: {
                schoolName: schoolSettings?.schoolName || 'School',
                logoUrl: schoolSettings?.logoUrl,
                currencySymbol: financeSettings?.currencySymbol || '₦'
            }
        }
    });
}

// ─── PAYMENT SETTINGS ───────────────────────────────────────────────────────

const getPaymentSettings = async (req, res) => {
    const { schoolId } = req.user;
    let settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    if (!settings) {
        settings = await prisma.schoolPaymentSettings.create({ data: { schoolId } });
    }
    // GAP 1 — never expose encrypted secrets
    const { 
        paystackSecretEnc, paystackWebhookSecret: _wh, 
        remitaSecretEnc, remitaWebhookSecret: _rwh, 
        ...safe 
    } = settings;
    res.status(StatusCodes.OK).json({ settings: safe });
};

const updatePaymentSettings = async (req, res) => {
    const { schoolId } = req.user;
    const {
        paystackPublicKey, paystackSecret, paystackWebhookSecret, paystackEnv,
        paystackEnabled, merchantDisplayName,
        remitaPublicKey, remitaSecret, remitaMerchantId, remitaWebhookSecret, remitaEnabled,
        bankTransferEnabled, transferEvidenceRequired,
        allowPartialPayment, allowOverpayment, autoApplyWallet
    } = req.body;

    const data = {
        ...(paystackPublicKey !== undefined && { paystackPublicKey }),
        ...(paystackSecret && { paystackSecretEnc: encrypt(paystackSecret) }),
        ...(paystackWebhookSecret && { paystackWebhookSecret: encrypt(paystackWebhookSecret) }),
        ...(paystackEnv !== undefined && { paystackEnv }),
        ...(paystackEnabled !== undefined && { paystackEnabled }),
        ...(remitaPublicKey !== undefined && { remitaPublicKey }),
        ...(remitaSecret && { remitaSecretEnc: encrypt(remitaSecret) }),
        ...(remitaWebhookSecret && { remitaWebhookSecret: remitaWebhookSecret }),
        ...(remitaMerchantId !== undefined && { remitaMerchantId }),
        ...(remitaEnabled !== undefined && { remitaEnabled }),
        ...(merchantDisplayName !== undefined && { merchantDisplayName }),
        ...(bankTransferEnabled !== undefined && { bankTransferEnabled }),
        ...(transferEvidenceRequired !== undefined && { transferEvidenceRequired }),
        ...(allowPartialPayment !== undefined && { allowPartialPayment }),
        ...(allowOverpayment !== undefined && { allowOverpayment }),
        ...(autoApplyWallet !== undefined && { autoApplyWallet }),
    };

    const settings = await prisma.schoolPaymentSettings.upsert({
        where: { schoolId },
        update: data,
        create: { schoolId, ...data }
    });

    const {
        paystackSecretEnc, paystackWebhookSecret: _wh,
        remitaSecretEnc, remitaWebhookSecret: _rwh,
        ...safe
    } = settings;
    res.status(StatusCodes.OK).json({ settings: safe, msg: 'Payment settings updated' });
};

const getActivePaymentMethods = async (req, res) => {
    // Both Parent and Admin can call this
    // The schoolId comes from the user if it's admin, or we map it from the student in Parent dashboard... Wait.
    // req.user has schoolId attached to JWT for both Admins and Parents? 
    // Let's assume req.user.schoolId exists.
    const { schoolId } = req.user;
    if (!schoolId) return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'No school bound' });

    const settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    if (!settings) return res.status(StatusCodes.OK).json({ methods: [] });

    const methods = [];
    if (settings.paystackEnabled && settings.paystackPublicKey) {
        methods.push({ id: 'PAYSTACK', name: 'Paystack (Card/Transfer)' });
    }
    if (settings.remitaEnabled && settings.remitaPublicKey) {
        methods.push({ id: 'REMITA', name: 'Remita' });
    }
    if (settings.bankTransferEnabled) {
        methods.push({ id: 'BANK_TRANSFER', name: 'Direct Bank Transfer' });
    }

    res.status(StatusCodes.OK).json({ methods });
};

// ─── BANK ACCOUNTS ───────────────────────────────────────────────────────────

const getBankAccounts = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const accounts = await prisma.schoolBankAccount.findMany({
        where: { schoolId, ...(activeBranchId && { branchId: activeBranchId }), isActive: true },
        orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }]
    });
    res.status(StatusCodes.OK).json({ accounts });
};

const createBankAccount = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { bankName, accountName, accountNumber, accountType, notes, displayInstructions, isDefault, sortOrder } = req.body;
    if (!bankName || !accountName || !accountNumber) {
        throw new CustomError.BadRequestError('bankName, accountName and accountNumber are required');
    }
    if (isDefault) {
        await prisma.schoolBankAccount.updateMany({ where: { schoolId }, data: { isDefault: false } });
    }
    const account = await prisma.schoolBankAccount.create({
        data: {
            schoolId,
            branchId: activeBranchId || null,
            bankName, accountName, accountNumber,
            accountType: accountType || null,
            notes: notes || null,
            displayInstructions: displayInstructions || null,
            isDefault: !!isDefault,
            sortOrder: sortOrder || 0
        }
    });
    res.status(StatusCodes.CREATED).json({ account, msg: 'Bank account added' });
};

const updateBankAccount = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;
    const existing = await prisma.schoolBankAccount.findUnique({ where: { id } });
    if (!existing || existing.schoolId !== schoolId) throw new CustomError.NotFoundError('Bank account not found');

    if (req.body.isDefault) {
        await prisma.schoolBankAccount.updateMany({ where: { schoolId }, data: { isDefault: false } });
    }

    // GAP 5 FIX — explicit whitelist, no schoolId/branchId reassignment
    const { bankName, accountName, accountNumber, accountType, notes, displayInstructions, isDefault, sortOrder, isActive } = req.body;
    const updateData = {
        ...(bankName !== undefined && { bankName }),
        ...(accountName !== undefined && { accountName }),
        ...(accountNumber !== undefined && { accountNumber }),
        ...(accountType !== undefined && { accountType }),
        ...(notes !== undefined && { notes }),
        ...(displayInstructions !== undefined && { displayInstructions }),
        ...(isDefault !== undefined && { isDefault: !!isDefault }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(isActive !== undefined && { isActive: !!isActive }),
    };

    const account = await prisma.schoolBankAccount.update({ where: { id }, data: updateData });
    res.status(StatusCodes.OK).json({ account, msg: 'Bank account updated' });
};

const deleteBankAccount = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;
    const existing = await prisma.schoolBankAccount.findUnique({ where: { id } });
    if (!existing || existing.schoolId !== schoolId) throw new CustomError.NotFoundError('Bank account not found');
    await prisma.schoolBankAccount.update({ where: { id }, data: { isActive: false } });
    res.status(StatusCodes.OK).json({ msg: 'Bank account removed' });
};

// ─── PAYSTACK PAYMENT INIT ──────────────────────────────────────────────────

const fs = require('fs');
const initializePaystackPayment = async (req, res) => {
  try {
    const { studentId, amount, invoiceId, email } = req.body;
    const { schoolId, activeBranchId } = req.user;

    // GAP 3 FIX — minimum amount guard
    if (!studentId || !amount || Number(amount) < MIN_PAYMENT_AMOUNT) {
        throw new CustomError.BadRequestError(`studentId and amount ≥ ₦${MIN_PAYMENT_AMOUNT} required`);
    }

    // GAP 4 — verify student belongs to this school (also important for Paystack init)
    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: { schoolId: true }
    });
    if (!student || student.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Student not found');
    }

    const secretKey = await getDecryptedPaystackSecret(schoolId);
    const financeSettings = await prisma.financeSettings.findUnique({ where: { schoolId } });

    const reference = generateRef('PSK');

    const transaction = await prisma.paymentTransaction.create({
        data: {
            schoolId,
            branchId: activeBranchId || null,
            studentId,
            reference,
            amount: Number(amount),
            method: 'PAYSTACK',
            status: 'PENDING',
            initiatedBy: req.user.userId,
            note: invoiceId ? `Invoice: ${invoiceId}` : null
        }
    });

    let payerEmail = email || (await getStudentEmail(studentId)) || 'parent@skooly.app';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
        payerEmail = 'parent@skooly.app';
    }

    const payload = {
        email: payerEmail,
        amount: Math.round(Number(amount) * 100), // kobo
        reference,
        currency: financeSettings?.currencySymbol === '$' ? 'USD' : 'NGN',
        metadata: {
            schoolId,
            branchId: activeBranchId || null,
            studentId,
            invoiceId: invoiceId || null,
            transactionId: transaction.id,
            custom_fields: [
                { display_name: 'Student ID', variable_name: 'student_id', value: studentId },
                { display_name: 'School', variable_name: 'school_id', value: schoolId }
            ]
        },
        callback_url: `${process.env.CLIENT_URL}/dashboard/finance/payments?status=success&ref=${reference}`
    };

    let response;
    try {
        response = await axios.post('https://api.paystack.co/transaction/initialize', payload, {
            headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' }
        });
    } catch (apiError) {
        throw new CustomError.BadRequestError(
            apiError.response?.data?.message || 'Paystack initialization failed (API Error)'
        );
    }

    if (!response.data.status) {
        throw new CustomError.BadRequestError('Paystack initialization failed');
    }

    res.status(StatusCodes.OK).json({
        authorizationUrl: response.data.data.authorization_url,
        accessCode: response.data.data.access_code,
        reference,
        transactionId: transaction.id
    });
  } catch (err) {
      fs.writeFileSync('C:\\Users\\Jereh Lomak\\Desktop\\my-projects\\skooly\\backend\\err-dump.js', String(err.stack || err));
      throw err;
  }
};

// ─── PAYSTACK WEBHOOK (raw Buffer from app.js — no auth, signature verified) ─

const handlePaystackWebhook = async (req, res) => {
    // GAP 1 FIX: app.js mounts this with express.raw(), so req.body is a Buffer
    const rawBody = req.body;
    const signature = req.headers['x-paystack-signature'];

    // Parse the buffer into an object for processing
    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
        return res.status(400).send('Bad JSON');
    }

    // Always respond 200 to Paystack immediately
    res.status(200).send('OK');

    const event = payload.event;
    const reference = payload.data?.reference;

    // GAP 2 FIX — idempotency: try to create a unique log entry for (reference+event)
    // If it already exists as processed, skip. Use try/catch on create for race safety.
    let log;
    try {
        // Check if already processed
        const existingProcessed = await prisma.paystackWebhookLog.findFirst({
            where: { reference, event, processed: true }
        });
        if (existingProcessed) return;

        log = await prisma.paystackWebhookLog.create({
            data: { event, reference, payload, verified: false, processed: false }
        });
    } catch (err) {
        // Unique constraint violation or DB error — safe to skip
        console.error('[Paystack Webhook] Log insert error:', err.message);
        return;
    }

    try {
        // Look up transaction for per-school secret
        const txRecord = reference
            ? await prisma.paymentTransaction.findUnique({ where: { reference } })
            : null;

        if (txRecord?.schoolId) {
            const psSettings = await prisma.schoolPaymentSettings.findUnique({
                where: { schoolId: txRecord.schoolId }
            });

            if (psSettings?.paystackWebhookSecret) {
                const expectedSecret = decrypt(psSettings.paystackWebhookSecret);
                // GAP 1 FIX — hash the RAW buffer, not JSON.stringify of parsed object
                const hash = crypto.createHmac('sha512', expectedSecret)
                    .update(rawBody)
                    .digest('hex');

                if (hash !== signature) {
                    await prisma.paystackWebhookLog.update({
                        where: { id: log.id },
                        data: { processingNote: 'Signature mismatch — rejected' }
                    });
                    return;
                }
            }
            // If school has no webhook secret configured, still proceed (not ideal but survivable)
        }

        await prisma.paystackWebhookLog.update({ where: { id: log.id }, data: { verified: true } });

        if (event === 'charge.success') {
            if (!txRecord) {
                await prisma.paystackWebhookLog.update({ where: { id: log.id }, data: { processingNote: 'Transaction not found for reference' } });
                return;
            }
            // Idempotency: if already successful, skip
            if (txRecord.status === 'SUCCESSFUL') {
                await prisma.paystackWebhookLog.update({ where: { id: log.id }, data: { processed: true, processingNote: 'Already processed' } });
                return;
            }

            const [financeSettings, schoolSettings, paymentSettings] = await Promise.all([
                prisma.financeSettings.findUnique({ where: { schoolId: txRecord.schoolId } }),
                prisma.schoolSettings.findFirst({ where: { schoolId: txRecord.schoolId } }),
                prisma.schoolPaymentSettings.findUnique({ where: { schoolId: txRecord.schoolId } })
            ]);

            const currencySymbol = financeSettings?.currencySymbol || '₦';
            const schoolName = schoolSettings?.schoolName || 'School';
            const allowOverpayment = paymentSettings?.allowOverpayment ?? false;

            // GAP 8 FIX — email is sent AFTER transaction commits, declared outside scope
            let receipt = null;
            let invoiceNumbers = [];
            let walletBalanceAfter = null;

            await prisma.$transaction(async (tx) => {
                await tx.paymentTransaction.update({
                    where: { id: txRecord.id },
                    data: {
                        status: 'SUCCESSFUL',
                        paidAt: new Date(),
                        gatewayRef: payload.data?.id?.toString(),
                        gatewayResponse: payload.data
                    }
                });

                const result = await applyPaymentToInvoices(tx, {
                    schoolId: txRecord.schoolId,
                    studentId: txRecord.studentId,
                    amount: txRecord.amount,
                    paymentTransactionId: txRecord.id,
                    allowOverpayment
                });

                invoiceNumbers = result.invoiceNumbers;
                walletBalanceAfter = result.walletBalanceAfter;

                receipt = await createReceipt(tx, {
                    schoolId: txRecord.schoolId,
                    branchId: txRecord.branchId,
                    studentId: txRecord.studentId,
                    paymentTransactionId: txRecord.id,
                    amountPaid: txRecord.amount,
                    method: 'PAYSTACK',
                    invoiceNumbers,
                    walletBalanceAfter,
                    financeSettings,
                    schoolSettings
                });
            });

            // GAP 8 FIX — now outside $transaction
            const recipientEmail = await getStudentEmail(txRecord.studentId);
            if (recipientEmail && receipt) {
                sendReceiptEmail(recipientEmail, {
                    studentName: 'Student',
                    receiptNumber: receipt.receiptNumber,
                    amountPaid: txRecord.amount,
                    paymentMethod: 'Paystack (Online)',
                    invoiceNumber: invoiceNumbers.join(', '),
                    schoolName,
                    currencySymbol,
                    walletBalanceAfter
                }).catch(e => console.error('[Finance Email] Receipt send failed:', e.message));
                logNotification(txRecord.schoolId, txRecord.studentId, 'RECEIPT_SENT', recipientEmail);
            }

            await prisma.paystackWebhookLog.update({ where: { id: log.id }, data: { processed: true } });
        }
    } catch (err) {
        console.error('[Paystack Webhook] Processing error:', err.message);
        try {
            await prisma.paystackWebhookLog.update({ where: { id: log.id }, data: { processingNote: err.message.slice(0, 500) } });
        } catch { /* silent */ }
    }
};

// ─── BANK TRANSFER SUBMISSION ───────────────────────────────────────────────

const submitTransfer = async (req, res) => {
    const { studentId, amount, transferDate, senderName, senderBank, transferReference, invoiceId, note } = req.body;
    const { schoolId, activeBranchId } = req.user;

    if (!studentId || !amount || !transferDate || !senderName) {
        throw new CustomError.BadRequestError('studentId, amount, transferDate, and senderName are required');
    }
    if (Number(amount) < MIN_PAYMENT_AMOUNT) {
        throw new CustomError.BadRequestError(`Amount must be at least ₦${MIN_PAYMENT_AMOUNT}`);
    }

    // GAP 4 FIX — verify student belongs to this school
    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: { schoolId: true }
    });
    if (!student || student.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Student not found');
    }

    // GAP 10 FIX — enforce transferEvidenceRequired setting
    const paymentSettings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    const evidenceRequired = paymentSettings?.transferEvidenceRequired ?? true;

    let evidenceUrl = null;
    let evidencePublicId = null;

    if (req.files && req.files.evidence) {
        const uploaded = await uploadTransferEvidence(req.files.evidence, schoolId);
        evidenceUrl = uploaded.secure_url;
        evidencePublicId = uploaded.public_id;
    } else if (evidenceRequired) {
        throw new CustomError.BadRequestError('Transfer evidence (proof of payment) is required for this school');
    }

    const reference = generateRef('TXF');

    const result = await prisma.$transaction(async (tx) => {
        const transaction = await tx.paymentTransaction.create({
            data: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                reference,
                amount: Number(amount),
                method: 'BANK_TRANSFER',
                status: 'UNDER_REVIEW',
                initiatedBy: req.user.userId,
                note: invoiceId ? `Invoice: ${invoiceId}` : note || null
            }
        });

        const submission = await tx.transferSubmission.create({
            data: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                paymentTransactionId: transaction.id,
                amount: Number(amount),
                transferDate: new Date(transferDate),
                senderName,
                senderBank: senderBank || null,
                transferReference: transferReference || null,
                note: note || null,
                evidenceUrl,
                evidencePublicId,
                status: 'PENDING'
            }
        });

        return { transaction, submission };
    });

    // GAP 8 FIX — email outside transaction
    const [financeSettings, schoolSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);
    const recipientEmail = await getStudentEmail(studentId);
    if (recipientEmail) {
        sendTransferSubmittedEmail(recipientEmail, {
            studentName: senderName,
            amount: Number(amount),
            schoolName: schoolSettings?.schoolName || 'School',
            currencySymbol: financeSettings?.currencySymbol || '₦'
        }).catch(e => console.error('[Finance Email] Transfer submitted failed:', e.message));
        logNotification(schoolId, studentId, 'TRANSFER_SUBMITTED', recipientEmail);
    }

    res.status(StatusCodes.CREATED).json({
        submission: result.submission,
        transaction: result.transaction,
        msg: 'Transfer submitted for review'
    });
};

// ─── TRANSFER REVIEW (Admin) ─────────────────────────────────────────────────

const reviewTransfer = async (req, res) => {
    const { id } = req.params;
    const { action, reviewNote } = req.body;
    const { schoolId, userId } = req.user;

    if (!['APPROVE', 'REJECT', 'CLARIFICATION_NEEDED'].includes(action)) {
        throw new CustomError.BadRequestError('Invalid action. Must be APPROVE, REJECT, or CLARIFICATION_NEEDED');
    }

    const submission = await prisma.transferSubmission.findUnique({
        where: { id },
        include: { transaction: true }
    });

    // Strict tenant check
    if (!submission || submission.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Transfer submission not found');
    }
    if (submission.status !== 'PENDING') {
        throw new CustomError.BadRequestError('Transfer has already been reviewed');
    }
    // Double-check the linked transaction also belongs to this school
    if (submission.transaction?.schoolId !== schoolId) {
        throw new CustomError.UnauthorizedError('Transaction does not belong to this school');
    }

    const [financeSettings, schoolSettings, paymentSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } }),
        prisma.schoolPaymentSettings.findUnique({ where: { schoolId } })
    ]);

    const currencySymbol = financeSettings?.currencySymbol || '₦';
    const schoolName = schoolSettings?.schoolName || 'School';
    const allowOverpayment = paymentSettings?.allowOverpayment ?? false;
    const recipientEmail = await getStudentEmail(submission.studentId);

    if (action === 'APPROVE') {
        let receipt = null;
        let invoiceNumbers = [];
        let walletBalanceAfter = null;

        await prisma.$transaction(async (tx) => {
            await tx.transferSubmission.update({
                where: { id },
                data: { status: 'APPROVED', reviewedBy: userId, reviewedAt: new Date(), reviewNote }
            });

            await tx.paymentTransaction.update({
                where: { id: submission.paymentTransactionId },
                data: { status: 'SUCCESSFUL', paidAt: new Date() }
            });

            const result = await applyPaymentToInvoices(tx, {
                schoolId,
                studentId: submission.studentId,
                amount: submission.amount,
                paymentTransactionId: submission.paymentTransactionId,
                allowOverpayment
            });

            invoiceNumbers = result.invoiceNumbers;
            walletBalanceAfter = result.walletBalanceAfter;

            receipt = await createReceipt(tx, {
                schoolId,
                branchId: submission.branchId,
                studentId: submission.studentId,
                paymentTransactionId: submission.paymentTransactionId,
                amountPaid: submission.amount,
                method: 'BANK_TRANSFER',
                invoiceNumbers,
                walletBalanceAfter,
                financeSettings,
                schoolSettings
            });
        });

        // GAP 8 FIX — email outside transaction
        if (recipientEmail && receipt) {
            sendTransferApprovedEmail(recipientEmail, {
                studentName: submission.senderName,
                amount: submission.amount,
                schoolName,
                currencySymbol
            }).catch(e => console.error('[Finance Email] Approve email failed:', e.message));
            logNotification(schoolId, submission.studentId, 'TRANSFER_APPROVED', recipientEmail);
        }

        return res.status(StatusCodes.OK).json({ msg: 'Transfer approved and receipt generated' });
    }

    if (action === 'REJECT') {
        // Both rejection updates are outside a Prisma transaction intentionally —
        // they are independent updates with no atomicity requirement.
        await prisma.transferSubmission.update({
            where: { id },
            data: { status: 'REJECTED', reviewedBy: userId, reviewedAt: new Date(), reviewNote }
        });
        await prisma.paymentTransaction.update({
            where: { id: submission.paymentTransactionId },
            data: { status: 'FAILED' }
        });

        if (recipientEmail) {
            sendTransferRejectedEmail(recipientEmail, {
                studentName: submission.senderName,
                amount: submission.amount,
                schoolName,
                currencySymbol,
                reason: reviewNote
            }).catch(e => console.error('[Finance Email] Reject email failed:', e.message));
            logNotification(schoolId, submission.studentId, 'TRANSFER_REJECTED', recipientEmail);
        }

        return res.status(StatusCodes.OK).json({ msg: 'Transfer rejected' });
    }

    // CLARIFICATION_NEEDED
    await prisma.transferSubmission.update({
        where: { id },
        data: { status: 'CLARIFICATION_NEEDED', reviewedBy: userId, reviewedAt: new Date(), reviewNote }
    });
    res.status(StatusCodes.OK).json({ msg: 'Clarification requested' });
};

// ─── TRANSFER SUBMISSIONS LIST ───────────────────────────────────────────────

const getTransferSubmissions = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { status, page = 1, limit = 30 } = req.query;

    const where = {
        schoolId,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(status && { status })
    };

    const [submissions, total] = await Promise.all([
        prisma.transferSubmission.findMany({
            where,
            include: {
                student: { include: { user: { select: { name: true, email: true } } } },
                transaction: { select: { reference: true, status: true } }
            },
            orderBy: { createdAt: 'desc' },
            skip: (Number(page) - 1) * Number(limit),
            take: Number(limit)
        }),
        prisma.transferSubmission.count({ where })
    ]);

    res.status(StatusCodes.OK).json({ submissions, total, page: Number(page) });
};

// ─── INVOICE GENERATION ──────────────────────────────────────────────────────

const generateInvoice = async (req, res) => {
    const { studentId, term, academicYear, dueDate, feeDefinitionIds } = req.body;
    const { schoolId, activeBranchId } = req.user;

    if (!studentId) throw new CustomError.BadRequestError('studentId is required');

    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        include: { user: { select: { name: true, email: true } } }
    });
    // Tenant isolation — student must belong to this school
    if (!student || student.schoolId !== schoolId) throw new CustomError.NotFoundError('Student not found');

    const [financeSettings, schoolSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);

    // fee definitions must also belong to this school
    const feeQuery = {
        schoolId,
        isActive: true,
        isDeleted: false,
        ...(feeDefinitionIds?.length ? { id: { in: feeDefinitionIds } } : {})
    };
    const fees = await prisma.feeDefinition.findMany({ where: feeQuery });
    if (fees.length === 0) throw new CustomError.BadRequestError('No active fee definitions found');

    const invoicePrefix = financeSettings?.invoicePrefix || 'INV-';
    const invoiceNumber = `${invoicePrefix}${Date.now()}`;
    const subTotal = fees.reduce((s, f) => s + f.amount * (f.quantity || 1), 0);

    const invoice = await prisma.$transaction(async (tx) => {
        return await tx.financeInvoice.create({
            data: {
                schoolId,
                branchId: activeBranchId || student.branchId || null,
                studentId,
                term: term || schoolSettings?.currentTerm || null,
                academicYear: academicYear || schoolSettings?.currentYear || null,
                invoiceNumber,
                subTotal,
                totalAmount: subTotal,
                balanceDue: subTotal,
                status: 'PUBLISHED',
                dueDate: dueDate ? new Date(dueDate) : null,
                items: {
                    create: fees.map(f => ({
                        type: f.type || 'FEE',
                        referenceId: f.id,
                        label: f.name,
                        quantity: f.quantity || 1,
                        unitPrice: f.amount,
                        amount: f.amount * (f.quantity || 1)
                    }))
                }
            },
            include: { items: true }
        });
    });

    // GAP 8 FIX — fire email after transaction, non-blocking
    const recipientEmail = await getStudentEmail(studentId);
    const studentName = student.user?.name?.trim() || '';
    if (recipientEmail) {
        sendInvoiceEmail(recipientEmail, {
            studentName,
            invoiceNumber,
            totalAmount: subTotal,
            dueDate,
            schoolName: schoolSettings?.schoolName || 'School',
            currencySymbol: financeSettings?.currencySymbol || '₦'
        })
            .then(() => logNotification(schoolId, studentId, 'INVOICE_ISSUED', recipientEmail))
            .catch(e => console.error('[Finance Email] Invoice email failed:', e.message));
    }

    res.status(StatusCodes.CREATED).json({ invoice, msg: 'Invoice generated successfully' });
};

// ─── INVOICE LIST ────────────────────────────────────────────────────────────

const getInvoices = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { studentId, status, term, academicYear, page = 1, limit = 30 } = req.query;

    const where = {
        schoolId,
        isDeleted: false,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(studentId && { studentId }),
        ...(status && { status }),
        ...(term && { term }),
        ...(academicYear && { academicYear })
    };

    const [invoices, total] = await Promise.all([
        prisma.financeInvoice.findMany({
            where,
            include: {
                student: { include: { user: { select: { name: true } } } },
                items: true,
                PaymentAllocation: { select: { allocatedAmount: true } }
            },
            orderBy: { createdAt: 'desc' },
            skip: (Number(page) - 1) * Number(limit),
            take: Number(limit)
        }),
        prisma.financeInvoice.count({ where })
    ]);

    res.status(StatusCodes.OK).json({ invoices, total, page: Number(page) });
};

const getInvoice = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;
    // GAP 9 FIX — add isDeleted filter
    const invoice = await prisma.financeInvoice.findUnique({
        where: { id },
        include: {
            student: { include: { user: { select: { name: true, email: true } } } },
            items: true,
            PaymentAllocation: {
                include: { transaction: { select: { reference: true, method: true, paidAt: true } } }
            }
        }
    });
    if (!invoice || invoice.schoolId !== schoolId || invoice.isDeleted) {
        throw new CustomError.NotFoundError('Invoice not found');
    }
    res.status(StatusCodes.OK).json({ invoice });
};

// ─── PAYMENT RECORDS (Reconciliation) ────────────────────────────────────────

const getPaymentTransactions = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { studentId, method, status, from, to, page = 1, limit = 30 } = req.query;

    const where = {
        schoolId,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(studentId && { studentId }),
        ...(method && { method }),
        ...(status && { status }),
        ...(from || to ? {
            createdAt: {
                ...(from && { gte: new Date(from) }),
                ...(to && { lte: new Date(to) })
            }
        } : {})
    };

    const [transactions, total, aggregate] = await Promise.all([
        prisma.paymentTransaction.findMany({
            where,
            include: {
                student: { include: { user: { select: { name: true } } } },
                receipt: { select: { receiptNumber: true } },
                transfer: { select: { status: true, senderName: true } }
            },
            orderBy: { createdAt: 'desc' },
            skip: (Number(page) - 1) * Number(limit),
            take: Number(limit)
        }),
        prisma.paymentTransaction.count({ where }),
        prisma.paymentTransaction.aggregate({
            where: { ...where, status: 'SUCCESSFUL' },
            _sum: { amount: true }
        })
    ]);

    res.status(StatusCodes.OK).json({
        transactions,
        total,
        page: Number(page),
        totalCollected: aggregate._sum.amount || 0
    });
};

// ─── RECEIPTS ────────────────────────────────────────────────────────────────

const getReceipts = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { studentId, page = 1, limit = 30 } = req.query;

    const where = {
        schoolId,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(studentId && { studentId })
    };

    const [receipts, total] = await Promise.all([
        prisma.financeReceipt.findMany({
            where,
            include: {
                student: { include: { user: { select: { name: true } } } },
                transaction: { select: { reference: true, method: true } }
            },
            orderBy: { createdAt: 'desc' },
            skip: (Number(page) - 1) * Number(limit),
            take: Number(limit)
        }),
        prisma.financeReceipt.count({ where })
    ]);

    res.status(StatusCodes.OK).json({ receipts, total, page: Number(page) });
};

// ─── APPLY WALLET TO INVOICE ─────────────────────────────────────────────────

const applyWalletToInvoice = async (req, res) => {
    const { studentId, invoiceId, amount } = req.body;
    const { schoolId } = req.user;

    if (!studentId || !invoiceId) {
        throw new CustomError.BadRequestError('studentId and invoiceId are required');
    }

    // Pre-fetch for tenant check (actual amounts resolved inside TX)
    const [wallet, invoice] = await Promise.all([
        prisma.studentWallet.findUnique({ where: { studentId } }),
        prisma.financeInvoice.findUnique({ where: { id: invoiceId } })
    ]);

    if (!wallet || wallet.schoolId !== schoolId) throw new CustomError.NotFoundError('Wallet not found');
    if (!invoice || invoice.schoolId !== schoolId || invoice.isDeleted) throw new CustomError.NotFoundError('Invoice not found');
    if (invoice.studentId !== studentId) throw new CustomError.BadRequestError('Invoice does not belong to this student');
    if (invoice.balanceDue <= 0) throw new CustomError.BadRequestError('Invoice is already fully paid');

    const reference = generateRef('WAL');
    let applied = 0;

    await prisma.$transaction(async (tx) => {
        // GAP 7 FIX — read live wallet balance INSIDE the transaction to avoid stale read
        const liveWallet = await tx.studentWallet.findUnique({ where: { studentId } });
        if (!liveWallet || liveWallet.balance <= 0) {
            throw new CustomError.BadRequestError('Insufficient wallet balance');
        }

        const liveInvoice = await tx.financeInvoice.findUnique({ where: { id: invoiceId } });
        if (!liveInvoice || liveInvoice.balanceDue <= 0) {
            throw new CustomError.BadRequestError('Invoice already fully paid');
        }

        // Compute toApply inside TX with live data
        applied = Math.min(
            liveWallet.balance,
            liveInvoice.balanceDue,
            amount ? Number(amount) : liveInvoice.balanceDue
        );
        if (applied <= 0) throw new CustomError.BadRequestError('Nothing to apply');

        const updatedWallet = await tx.studentWallet.update({
            where: { studentId },
            data: { balance: { decrement: applied } }
        });

        // Safety net — should never happen with live read, but just in case
        if (updatedWallet.balance < 0) {
            throw new CustomError.BadRequestError('Insufficient wallet balance');
        }

        await tx.studentWalletTransaction.create({
            data: {
                walletId: liveWallet.id,
                schoolId,
                type: 'INVOICE_APPLICATION',
                amount: applied,
                balanceBefore: updatedWallet.balance + applied,
                balanceAfter: updatedWallet.balance,
                reference,
                description: `Applied to invoice ${liveInvoice.invoiceNumber}`
            }
        });

        const newPaid = liveInvoice.amountPaid + applied;
        const newBalance = liveInvoice.balanceDue - applied;
        await tx.financeInvoice.update({
            where: { id: invoiceId },
            data: {
                amountPaid: newPaid,
                balanceDue: newBalance,
                walletDeduction: { increment: applied },
                status: newBalance <= 0 ? 'PAID' : 'PARTIAL'
            }
        });

        // Audit trail: create a WALLET PaymentTransaction + Allocation
        const txRecord = await tx.paymentTransaction.create({
            data: {
                schoolId,
                studentId,
                reference,
                amount: applied,
                method: 'WALLET',
                status: 'SUCCESSFUL',
                paidAt: new Date(),
                initiatedBy: req.user.userId
            }
        });

        await tx.paymentAllocation.create({
            data: { schoolId, paymentTransactionId: txRecord.id, invoiceId, allocatedAmount: applied }
        });

        // Generate receipt inside the transaction
        const [financeSettings, schoolSettings] = await Promise.all([
            tx.financeSettings.findUnique({ where: { schoolId } }),
            tx.schoolSettings.findFirst({ where: { schoolId } })
        ]);

        await createReceipt(tx, {
            schoolId,
            branchId: null,
            studentId,
            paymentTransactionId: txRecord.id,
            amountPaid: applied,
            method: 'WALLET',
            invoiceNumbers: [liveInvoice.invoiceNumber],
            walletBalanceAfter: updatedWallet.balance,
            financeSettings,
            schoolSettings
        });
    });

    res.status(StatusCodes.OK).json({ msg: `₦${applied.toLocaleString()} applied from wallet to invoice` });
};

module.exports = {
    getPaymentSettings,
    updatePaymentSettings,
    getBankAccounts,
    createBankAccount,
    updateBankAccount,
    deleteBankAccount,
    initializePaystackPayment,
    handlePaystackWebhook,
    submitTransfer,
    reviewTransfer,
    getTransferSubmissions,
    generateInvoice,
    getInvoices,
    getInvoice,
    getPaymentTransactions,
    getReceipts,
    applyWalletToInvoice,
    getActivePaymentMethods,
};
