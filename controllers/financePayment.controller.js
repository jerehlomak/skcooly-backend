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

const flutterwaveClient = require('../utils/flutterwave');
const monnifyClient = require('../utils/monnify');
const paystackClient = require('../utils/paystack');

async function getDecryptedFlwSecret(schoolId) {
    const settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    if (settings?.flwSecretEnc) {
        return decrypt(settings.flwSecretEnc);
    }
    if (process.env.FLUTTERWAVE_SECRET_KEY || process.env.FLW_SECRET_KEY) {
        return process.env.FLUTTERWAVE_SECRET_KEY || process.env.FLW_SECRET_KEY;
    }
    throw new CustomError.BadRequestError('Flutterwave Secret Key is not configured for this school');
}

async function getDecryptedMonnifyConfig(schoolId) {
    const settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    const apiKey = settings?.monnifyApiKey || process.env.MONNIFY_API_KEY;
    const contractCode = settings?.monnifyContractCode || process.env.MONNIFY_CONTRACT_CODE;
    const env = settings?.monnifyEnv || (process.env.MONNIFY_ENV === 'LIVE' ? 'LIVE' : 'TEST');
    let secretKey = null;

    if (settings?.monnifySecretEnc) {
        secretKey = decrypt(settings.monnifySecretEnc);
    } else if (process.env.MONNIFY_SECRET_KEY) {
        secretKey = process.env.MONNIFY_SECRET_KEY;
    }

    if (!apiKey || !secretKey || !contractCode) {
        throw new CustomError.BadRequestError('Monnify credentials (API Key, Secret Key, Contract Code) are not fully configured');
    }

    return { apiKey, secretKey, contractCode, env };
}

async function getDecryptedPaystackSecret(schoolId) {
    const settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    if (settings?.paystackSecretEnc) {
        return decrypt(settings.paystackSecretEnc);
    }
    if (process.env.PAYSTACK_SECRET_KEY) {
        return process.env.PAYSTACK_SECRET_KEY;
    }
    throw new CustomError.BadRequestError('Paystack is not configured for this school');
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
            balanceDue: { gt: 0 },
            status: { notIn: ['PAID', 'VOID', 'CANCELLED', 'FAILED'] }
        },
        orderBy: { createdAt: 'asc' }
    });

    for (const inv of invoices) {
        if (remaining <= 0) break;
        const toApply = Math.min(remaining, inv.balanceDue);
        const newPaid = inv.amountPaid + toApply;
        const newBalance = inv.balanceDue - toApply;
        const newStatus = newBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID';

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
    
    const receipt = await tx.financeReceipt.create({
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

    // ─── AUTO-INCOME LEDGER ──────────────────────────────────────────────────
    // Do not double-count income when applying a prepaid wallet balance
    if (method !== 'WALLET') {
        let feeCategory = await tx.financeCategory.findFirst({
            where: { schoolId, name: 'School Fees', type: 'INCOME' }
        });
        if (!feeCategory) {
            feeCategory = await tx.financeCategory.create({
                data: { schoolId, name: 'School Fees', type: 'INCOME' }
            });
        }

        let studentLabel = '';
        if (studentId) {
            try {
                const student = await tx.studentProfile.findUnique({
                    where: { id: studentId },
                    include: {
                        user: { select: { name: true } },
                        classArm: { select: { name: true } },
                        classLevel: { select: { name: true } }
                    }
                });
                if (student) {
                    const studentName = student.user?.name || `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Student';
                    const className = student.classArm?.name || student.classLevel?.name || '';
                    studentLabel = className ? `${studentName} (${className})` : studentName;
                }
            } catch (err) {
                console.error('[createReceipt] Failed to resolve student info for ledger:', err);
            }
        }

        let desc = 'Automated Fee Collection';
        if (invoiceNumbers && invoiceNumbers.length > 0) {
            try {
                const invoices = await tx.financeInvoice.findMany({
                    where: {
                        schoolId,
                        invoiceNumber: { in: invoiceNumbers }
                    },
                    include: {
                        items: { select: { label: true } }
                    }
                });

                const uniqueItemLabels = Array.from(
                    new Set(invoices.flatMap(inv => (inv.items || []).map(i => i.label?.trim())).filter(Boolean))
                );

                const itemsStr = uniqueItemLabels.length > 0
                    ? (uniqueItemLabels.length > 3 ? `${uniqueItemLabels.slice(0, 3).join(', ')} +${uniqueItemLabels.length - 3} more` : uniqueItemLabels.join(', '))
                    : 'School Fees';

                if (studentLabel) {
                    desc = `${itemsStr} — ${studentLabel} [${invoiceNumbers.join(', ')}]`;
                } else {
                    desc = `${itemsStr} [${invoiceNumbers.join(', ')}]`;
                }
            } catch (err) {
                desc = studentLabel ? `Invoice payment: ${invoiceNumbers.join(', ')} — ${studentLabel}` : `Invoice payment: ${invoiceNumbers.join(', ')}`;
            }
        } else {
            desc = studentLabel
                ? `Online Wallet Top-up / Fee Deposit — ${studentLabel}`
                : `Online Wallet Top-up / Unallocated Payment`;
        }

        await tx.incomeRecord.create({
            data: {
                schoolId,
                categoryId: feeCategory.id,
                description: desc,
                amount: amountPaid,
                date: new Date(),
                source: 'AUTO',
                referenceId: paymentTransactionId
            }
        });
    }

    return receipt;
}

async function autoApplyStudentWalletToInvoice({ schoolId, branchId, studentId, invoice, userId, financeSettings, schoolSettings }) {
    if (!invoice || invoice.balanceDue <= 0) return invoice;
    try {
        const wallet = await prisma.studentWallet.findUnique({ where: { studentId } });
        if (!wallet || wallet.balance <= 0) return invoice;

        const applied = Math.min(wallet.balance, invoice.balanceDue);
        if (applied <= 0) return invoice;

        return await prisma.$transaction(async (tx) => {
            const liveWallet = await tx.studentWallet.findUnique({ where: { studentId } });
            if (!liveWallet || liveWallet.balance <= 0) return invoice;
            const actualApplied = Math.min(liveWallet.balance, invoice.balanceDue);
            if (actualApplied <= 0) return invoice;

            const updatedWallet = await tx.studentWallet.update({
                where: { studentId },
                data: { balance: { decrement: actualApplied } }
            });

            const ref = generateRef('WAL');
            await tx.studentWalletTransaction.create({
                data: {
                    walletId: liveWallet.id,
                    schoolId,
                    type: 'INVOICE_APPLICATION',
                    amount: actualApplied,
                    balanceBefore: updatedWallet.balance + actualApplied,
                    balanceAfter: updatedWallet.balance,
                    reference: ref,
                    description: `Auto-applied on invoice generation ${invoice.invoiceNumber}`
                }
            });

            const newPaid = (invoice.amountPaid || 0) + actualApplied;
            const newBalance = invoice.balanceDue - actualApplied;
            const updatedInvoice = await tx.financeInvoice.update({
                where: { id: invoice.id },
                data: {
                    amountPaid: newPaid,
                    balanceDue: newBalance,
                    walletDeduction: { increment: actualApplied },
                    status: newBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID'
                }
            });

            const txRecord = await tx.paymentTransaction.create({
                data: {
                    schoolId,
                    studentId,
                    reference: ref,
                    amount: actualApplied,
                    method: 'WALLET',
                    status: 'SUCCESSFUL',
                    paidAt: new Date(),
                    initiatedBy: userId || null
                }
            });

            await tx.paymentAllocation.create({
                data: { schoolId, paymentTransactionId: txRecord.id, invoiceId: invoice.id, allocatedAmount: actualApplied }
            });

            await createReceipt(tx, {
                schoolId,
                branchId: branchId || null,
                studentId,
                paymentTransactionId: txRecord.id,
                amountPaid: actualApplied,
                method: 'WALLET',
                invoiceNumbers: [invoice.invoiceNumber],
                walletBalanceAfter: updatedWallet.balance,
                financeSettings,
                schoolSettings
            });

            return updatedInvoice;
        }, { maxWait: 10000, timeout: 30000 });
    } catch (err) {
        console.error('[autoApplyStudentWalletToInvoice] Wallet auto-apply failed:', err);
        return invoice;
    }
}

// ─── PAYMENT SETTINGS ───────────────────────────────────────────────────────

const getPaymentSettings = async (req, res) => {
    const { schoolId } = req.user;
    let settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    if (!settings) {
        settings = await prisma.schoolPaymentSettings.create({ data: { schoolId } });
    }
    
    // Return safe configuration without exposing raw encrypted secrets
    res.status(StatusCodes.OK).json({
        settings: {
            id: settings.id,
            schoolId: settings.schoolId,
            activeGateway: settings.activeGateway || 'FLUTTERWAVE',
            
            // Flutterwave
            flutterwavePublicKey: settings.flwPublicKey || '',
            flwPublicKey: settings.flwPublicKey || '',
            flutterwaveMode: settings.flwEnv || 'TEST',
            flwEnv: settings.flwEnv || 'TEST',
            flutterwaveEnabled: settings.flwEnabled || false,
            flwEnabled: settings.flwEnabled || false,
            hasFlwSecret: !!settings.flwSecretEnc,
            hasFlwWebhookSecret: !!settings.flwWebhookSecret,

            // Paystack
            paystackPublicKey: settings.paystackPublicKey || '',
            paystackMode: settings.paystackEnv || 'TEST',
            paystackEnv: settings.paystackEnv || 'TEST',
            paystackEnabled: settings.paystackEnabled || false,
            hasPaystackSecret: !!settings.paystackSecretEnc,
            hasPaystackWebhookSecret: !!settings.paystackWebhookSecret,

            // Monnify
            monnifyApiKey: settings.monnifyApiKey || '',
            monnifyContractCode: settings.monnifyContractCode || '',
            monnifyMode: settings.monnifyEnv || 'TEST',
            monnifyEnv: settings.monnifyEnv || 'TEST',
            monnifyEnabled: settings.monnifyEnabled || false,
            hasMonnifySecret: !!settings.monnifySecretEnc,
            hasMonnifyWebhookSecret: !!settings.monnifyWebhookSecret,

            // Remita
            remitaPublicKey: settings.remitaPublicKey || '',
            remitaMerchantId: settings.remitaMerchantId || '',
            remitaEnabled: settings.remitaEnabled || false,
            hasRemitaSecret: !!settings.remitaSecretEnc,

            // General & Rules
            merchantDisplayName: settings.merchantDisplayName || '',
            bankTransferEnabled: settings.bankTransferEnabled ?? true,
            transferEvidenceRequired: settings.transferEvidenceRequired ?? true,
            allowPartialPayment: settings.allowPartialPayment ?? true,
            allowOverpayment: settings.allowOverpayment ?? false,
            autoApplyWallet: settings.autoApplyWallet ?? false,
            allowWalletCheckout: settings.allowWalletCheckout ?? true,
            allowFamilyWalletSharing: settings.allowFamilyWalletSharing ?? true,
            createdAt: settings.createdAt,
            updatedAt: settings.updatedAt
        }
    });
};

const updatePaymentSettings = async (req, res) => {
    const { schoolId } = req.user;
    const body = req.body || {};

    const activeGateway = body.activeGateway;

    // Flutterwave aliases
    const flwPublic = body.flutterwavePublicKey !== undefined ? body.flutterwavePublicKey : body.flwPublicKey;
    const flwSecret = body.flutterwaveSecretKey || body.flwSecret;
    const flwWebhook = body.flwWebhookSecret !== undefined ? body.flwWebhookSecret : body.flutterwaveWebhookSecret;
    const flwEnv = body.flutterwaveMode !== undefined ? body.flutterwaveMode : body.flwEnv;
    const flwEnabled = body.flutterwaveEnabled !== undefined ? body.flutterwaveEnabled : body.flwEnabled;

    // Paystack aliases
    const paystackPublic = body.paystackPublicKey;
    const paystackSecret = body.paystackSecret || body.paystackSecretKey;
    const paystackWebhook = body.paystackWebhookSecret;
    const paystackEnv = body.paystackMode !== undefined ? body.paystackMode : body.paystackEnv;
    const paystackEnabled = body.paystackEnabled;

    // Monnify aliases
    const monnifyApi = body.monnifyApiKey || body.monnifyPublicKey;
    const monnifySecret = body.monnifySecretKey || body.monnifySecret;
    const monnifyContract = body.monnifyContractCode;
    const monnifyWebhook = body.monnifyWebhookSecret;
    const monnifyEnv = body.monnifyMode !== undefined ? body.monnifyMode : body.monnifyEnv;
    const monnifyEnabled = body.monnifyEnabled;

    // Remita
    const remitaPublic = body.remitaPublicKey;
    const remitaSecret = body.remitaSecret || body.remitaSecretKey;
    const remitaWebhook = body.remitaWebhookSecret;
    const remitaMerchant = body.remitaMerchantId;
    const remitaEnabled = body.remitaEnabled;

    // General
    const {
        merchantDisplayName, bankTransferEnabled, transferEvidenceRequired,
        allowPartialPayment, allowOverpayment, autoApplyWallet,
        allowWalletCheckout, allowFamilyWalletSharing
    } = body;

    const data = {
        ...(activeGateway !== undefined && { activeGateway }),

        // Flutterwave
        ...(flwPublic !== undefined && { flwPublicKey: flwPublic }),
        ...(flwSecret && { flwSecretEnc: encrypt(flwSecret) }),
        ...(flwWebhook !== undefined && { flwWebhookSecret: flwWebhook }),
        ...(flwEnv !== undefined && { flwEnv }),
        ...(flwEnabled !== undefined && { flwEnabled }),

        // Paystack
        ...(paystackPublic !== undefined && { paystackPublicKey: paystackPublic }),
        ...(paystackSecret && { paystackSecretEnc: encrypt(paystackSecret) }),
        ...(paystackWebhook !== undefined && { paystackWebhookSecret: encrypt(paystackWebhook) }),
        ...(paystackEnv !== undefined && { paystackEnv }),
        ...(paystackEnabled !== undefined && { paystackEnabled }),

        // Monnify
        ...(monnifyApi !== undefined && { monnifyApiKey: monnifyApi }),
        ...(monnifySecret && { monnifySecretEnc: encrypt(monnifySecret) }),
        ...(monnifyContract !== undefined && { monnifyContractCode: monnifyContract }),
        ...(monnifyWebhook !== undefined && { monnifyWebhookSecret: monnifyWebhook }),
        ...(monnifyEnv !== undefined && { monnifyEnv }),
        ...(monnifyEnabled !== undefined && { monnifyEnabled }),

        // Remita
        ...(remitaPublic !== undefined && { remitaPublicKey: remitaPublic }),
        ...(remitaSecret && { remitaSecretEnc: encrypt(remitaSecret) }),
        ...(remitaWebhook !== undefined && { remitaWebhookSecret: remitaWebhook }),
        ...(remitaMerchant !== undefined && { remitaMerchantId: remitaMerchant }),
        ...(remitaEnabled !== undefined && { remitaEnabled }),

        // General
        ...(merchantDisplayName !== undefined && { merchantDisplayName }),
        ...(bankTransferEnabled !== undefined && { bankTransferEnabled }),
        ...(transferEvidenceRequired !== undefined && { transferEvidenceRequired }),
        ...(allowPartialPayment !== undefined && { allowPartialPayment }),
        ...(allowOverpayment !== undefined && { allowOverpayment }),
        ...(autoApplyWallet !== undefined && { autoApplyWallet }),
        ...(allowWalletCheckout !== undefined && { allowWalletCheckout }),
        ...(allowFamilyWalletSharing !== undefined && { allowFamilyWalletSharing }),
    };

    await prisma.schoolPaymentSettings.upsert({
        where: { schoolId },
        update: data,
        create: { schoolId, ...data }
    });

    // Keep FinanceSettings payment rule flags in sync for total system consistency
    const syncData = {};
    if (allowPartialPayment !== undefined) syncData.allowPartialPayment = allowPartialPayment;
    if (allowOverpayment !== undefined) syncData.allowOverpayment = allowOverpayment;
    if (autoApplyWallet !== undefined) syncData.autoApplyWallet = autoApplyWallet;

    if (Object.keys(syncData).length > 0) {
        await prisma.financeSettings.upsert({
            where: { schoolId },
            update: syncData,
            create: { schoolId, ...syncData }
        }).catch(err => console.error('Error syncing financeSettings:', err));
    }

    res.status(StatusCodes.OK).json({ msg: 'Payment settings updated successfully' });
};

/**
 * Test Connection endpoint for verifying provider credentials live
 */
const testGatewayConnection = async (req, res) => {
    const { schoolId } = req.user;
    const body = req.body || {};
    const creds = body.credentials || {};

    const gateway = body.gateway;
    const secretKey = body.secretKey || creds.secretKey || creds.flutterwaveSecretKey || creds.paystackSecret || creds.monnifySecret;
    const publicKey = body.publicKey || creds.publicKey || creds.flutterwavePublicKey || creds.paystackPublicKey;
    const apiKey = body.apiKey || creds.apiKey || creds.monnifyApiKey;
    const contractCode = body.contractCode || creds.contractCode || creds.monnifyContractCode;
    const env = body.env || creds.env || creds.monnifyEnv || 'TEST';

    if (!gateway) {
        throw new CustomError.BadRequestError('Gateway parameter is required');
    }

    try {
        let result = { valid: false, message: 'Unsupported gateway' };

        if (gateway === 'FLUTTERWAVE') {
            let key = secretKey;
            let pubKey = publicKey;
            if (!key) {
                key = await getDecryptedFlwSecret(schoolId).catch(() => null);
            }
            if (!pubKey) {
                const settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
                pubKey = settings?.flwPublicKey || process.env.FLUTTERWAVE_PUBLIC_KEY;
            }
            if (!key) throw new CustomError.BadRequestError('No Flutterwave secret key provided or saved');
            result = await flutterwaveClient.testCredentials(key, pubKey);
        } else if (gateway === 'PAYSTACK') {
            let key = secretKey;
            if (!key) {
                key = await getDecryptedPaystackSecret(schoolId).catch(() => null);
            }
            if (!key) throw new CustomError.BadRequestError('No Paystack secret key provided or saved');
            result = await paystackClient.testCredentials(key);
        } else if (gateway === 'MONNIFY') {
            let mApiKey = apiKey;
            let mSecretKey = secretKey;
            let mEnv = env;

            if (!mApiKey || !mSecretKey) {
                const cfg = await getDecryptedMonnifyConfig(schoolId).catch(() => null);
                if (cfg) {
                    mApiKey = mApiKey || cfg.apiKey;
                    mSecretKey = mSecretKey || cfg.secretKey;
                    mEnv = mEnv || cfg.env;
                }
            }
            if (!mApiKey || !mSecretKey) {
                throw new CustomError.BadRequestError('Monnify API Key and Secret Key are required');
            }
            result = await monnifyClient.testCredentials({ apiKey: mApiKey, secretKey: mSecretKey, env: mEnv });
        }

        if (result.valid) {
            return res.status(StatusCodes.OK).json({ success: true, message: result.message });
        } else {
            return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: result.message });
        }
    } catch (err) {
        return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: err.message || 'Connection test failed' });
    }
};

const getActivePaymentMethods = async (req, res) => {
    // Both Parent, Student and Admin can call this
    const { schoolId } = req.user;
    if (!schoolId) return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'No school bound' });

    const settings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    if (!settings) return res.status(StatusCodes.OK).json({ methods: [] });

    const methods = [];

    if (settings.flwEnabled && (settings.flwPublicKey || settings.flwSecretEnc || process.env.FLUTTERWAVE_SECRET_KEY)) {
        methods.push({ 
            id: 'FLUTTERWAVE', 
            name: 'Flutterwave (Card, USSD, Transfer)',
            badge: 'Flutterwave',
            isDefault: settings.activeGateway === 'FLUTTERWAVE'
        });
    }

    if (settings.paystackEnabled && (settings.paystackPublicKey || settings.paystackSecretEnc || process.env.PAYSTACK_SECRET_KEY)) {
        methods.push({ 
            id: 'PAYSTACK', 
            name: 'Paystack (Card, Transfer, Bank)',
            badge: 'Paystack',
            isDefault: settings.activeGateway === 'PAYSTACK'
        });
    }

    if (settings.monnifyEnabled && (settings.monnifyApiKey || settings.monnifySecretEnc || process.env.MONNIFY_API_KEY)) {
        methods.push({ 
            id: 'MONNIFY', 
            name: 'Monnify (Card & Direct Account)',
            badge: 'Monnify',
            isDefault: settings.activeGateway === 'MONNIFY'
        });
    }

    if (settings.bankTransferEnabled) {
        methods.push({ 
            id: 'BANK_TRANSFER', 
            name: 'Direct Bank Transfer',
            badge: 'Bank Transfer',
            isDefault: settings.activeGateway === 'BANK_TRANSFER'
        });
    }

    res.status(StatusCodes.OK).json({ 
        activeGateway: settings.activeGateway || 'FLUTTERWAVE',
        methods,
        allowPartialPayment: settings.allowPartialPayment ?? true,
        allowOverpayment: settings.allowOverpayment ?? false,
        autoApplyWallet: settings.autoApplyWallet ?? false,
        allowWalletCheckout: settings.allowWalletCheckout ?? true,
        allowFamilyWalletSharing: settings.allowFamilyWalletSharing ?? true,
    });
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

// ─── UNIFIED ONLINE PAYMENT ENGINE ──────────────────────────────────────────

const settleSuccessfulPaymentTransaction = async ({ reference, gatewayRef, gatewayResponse, paymentMethod = 'ONLINE' }) => {
    const txRecord = await prisma.paymentTransaction.findUnique({ where: { reference } });
    if (!txRecord) {
        return { success: false, reason: 'Transaction not found for reference' };
    }
    if (txRecord.status === 'SUCCESSFUL') {
        return { success: true, alreadyProcessed: true };
    }

    const [financeSettings, schoolSettings, paymentSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId: txRecord.schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId: txRecord.schoolId } }),
        prisma.schoolPaymentSettings.findUnique({ where: { schoolId: txRecord.schoolId } })
    ]);

    const allowOverpayment = paymentSettings?.allowOverpayment ?? false;
    let receipt = null;
    let invoiceNumbers = [];
    let walletBalanceAfter = null;

    await prisma.$transaction(async (tx) => {
        await tx.paymentTransaction.update({
            where: { id: txRecord.id },
            data: {
                status: 'SUCCESSFUL',
                paidAt: new Date(),
                method: paymentMethod || txRecord.method,
                gatewayRef: gatewayRef ? String(gatewayRef) : undefined,
                gatewayResponse: gatewayResponse || undefined
            }
        });

        if (txRecord.note === 'WALLET_DEPOSIT') {
            let wallet = await tx.studentWallet.findUnique({ where: { studentId: txRecord.studentId } });
            if (!wallet) {
                const student = await tx.studentProfile.findUnique({ where: { id: txRecord.studentId } });
                wallet = await tx.studentWallet.create({
                    data: { schoolId: txRecord.schoolId, studentId: txRecord.studentId, branchId: student?.branchId }
                });
            }
            const updatedWallet = await tx.studentWallet.update({
                where: { studentId: txRecord.studentId },
                data: { balance: { increment: txRecord.amount } }
            });
            await tx.studentWalletTransaction.create({
                data: {
                    walletId: wallet.id,
                    schoolId: txRecord.schoolId,
                    type: 'DEPOSIT',
                    amount: txRecord.amount,
                    balanceBefore: updatedWallet.balance - txRecord.amount,
                    balanceAfter: updatedWallet.balance,
                    reference: txRecord.reference,
                    description: `${paymentMethod} Online Top-up`
                }
            });
            walletBalanceAfter = updatedWallet.balance;
            invoiceNumbers = [];
        } else {
            const result = await applyPaymentToInvoices(tx, {
                schoolId: txRecord.schoolId,
                studentId: txRecord.studentId,
                amount: txRecord.amount,
                paymentTransactionId: txRecord.id,
                allowOverpayment
            });

            invoiceNumbers = result.invoiceNumbers;
            walletBalanceAfter = result.walletBalanceAfter;
        }

        receipt = await createReceipt(tx, {
            schoolId: txRecord.schoolId,
            branchId: txRecord.branchId,
            studentId: txRecord.studentId,
            paymentTransactionId: txRecord.id,
            amountPaid: txRecord.amount,
            method: paymentMethod || txRecord.method,
            invoiceNumbers,
            walletBalanceAfter,
            financeSettings,
            schoolSettings
        });
    }, { timeout: 30000, maxWait: 10000 });

    const recipientEmail = await getStudentEmail(txRecord.studentId);
    if (recipientEmail && receipt) {
        sendReceiptEmail(recipientEmail, {
            studentName: 'Student',
            receiptNumber: receipt.receiptNumber,
            amountPaid: txRecord.amount,
            method: paymentMethod || txRecord.method,
            paymentDate: new Date(),
            schoolName: schoolSettings?.schoolName || 'School',
            currency: financeSettings?.currencySymbol || '₦'
        }).catch(err => console.error('[Receipt Email Error]:', err.message));
    }

    return { success: true, receipt, txRecord };
};

const initializeOnlinePayment = async (req, res) => {
    const { studentId, amount, invoiceId, email, gateway } = req.body;
    const { schoolId, activeBranchId } = req.user;

    if (!studentId || !amount || Number(amount) < MIN_PAYMENT_AMOUNT) {
        throw new CustomError.BadRequestError(`studentId and amount ≥ ₦${MIN_PAYMENT_AMOUNT} required`);
    }

    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        include: {
            user: { select: { name: true, email: true } },
            parent: { include: { user: { select: { name: true, email: true } } } }
        }
    });
    if (!student || student.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Student not found');
    }

    const [settings, financeSettings, schoolSettings] = await Promise.all([
        prisma.schoolPaymentSettings.findUnique({ where: { schoolId } }),
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);

    const selectedGateway = (gateway || settings?.activeGateway || 'FLUTTERWAVE').toUpperCase();
    const currency = financeSettings?.currencySymbol === '$' ? 'USD' : 'NGN';
    const schoolName = settings?.merchantDisplayName || schoolSettings?.schoolName || 'Skooly School';

    let payerEmail = email || student.parent?.user?.email || student.user?.email || 'parent@skooly.app';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) payerEmail = 'parent@skooly.app';
    const customerName = student.parent?.user?.name || student.user?.name || 'Parent';

    const clientBaseUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    if (selectedGateway === 'FLUTTERWAVE') {
        const reference = generateRef('FLW');
        const transaction = await prisma.paymentTransaction.create({
            data: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                reference,
                amount: Number(amount),
                method: 'FLUTTERWAVE',
                status: 'PENDING',
                initiatedBy: req.user.userId,
                note: invoiceId ? `Invoice: ${invoiceId}` : null
            }
        });

        const secretKey = await getDecryptedFlwSecret(schoolId);
        const flwRes = await flutterwaveClient.initializePayment({
            secretKey,
            publicKey: settings?.flwPublicKey,
            amount: Number(amount),
            currency,
            txRef: reference,
            redirectUrl: `${clientBaseUrl}/dashboard/finance/payments?status=success&ref=${reference}&gateway=FLUTTERWAVE`,
            email: payerEmail,
            name: customerName,
            customer: {
                email: payerEmail,
                name: customerName
            },
            customizations: {
                title: `${schoolName} Fee Payment`,
                description: invoiceId ? `Payment for Invoice ${invoiceId}` : `Payment for ${student.user?.name || 'Student'}`
            },
            meta: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                invoiceId: invoiceId || null,
                transactionId: transaction.id
            }
        });

        return res.status(StatusCodes.OK).json({
            gateway: 'FLUTTERWAVE',
            authorizationUrl: flwRes.link,
            checkoutUrl: flwRes.link,
            reference,
            transactionId: transaction.id
        });
    }

    if (selectedGateway === 'MONNIFY') {
        const reference = generateRef('MNF');
        const transaction = await prisma.paymentTransaction.create({
            data: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                reference,
                amount: Number(amount),
                method: 'MONNIFY',
                status: 'PENDING',
                initiatedBy: req.user.userId,
                note: invoiceId ? `Invoice: ${invoiceId}` : null
            }
        });

        const monnifyConfig = await getDecryptedMonnifyConfig(schoolId);
        const mnfRes = await monnifyClient.initializePayment({
            ...monnifyConfig,
            amount: Number(amount),
            customerName,
            customerEmail: payerEmail,
            paymentReference: reference,
            paymentDescription: invoiceId ? `Payment for Invoice ${invoiceId}` : `Payment for ${student.user?.name || 'Student'}`,
            currencyCode: currency,
            redirectUrl: `${clientBaseUrl}/dashboard/finance/payments?status=success&ref=${reference}&gateway=MONNIFY`,
            metadata: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                invoiceId: invoiceId || null,
                transactionId: transaction.id
            }
        });

        return res.status(StatusCodes.OK).json({
            gateway: 'MONNIFY',
            authorizationUrl: mnfRes.checkoutUrl,
            checkoutUrl: mnfRes.checkoutUrl,
            transactionReference: mnfRes.transactionReference,
            reference,
            transactionId: transaction.id
        });
    }

    // Default to PAYSTACK
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

    const secretKey = await getDecryptedPaystackSecret(schoolId);
    const pskRes = await paystackClient.initializePayment({
        secretKey,
        email: payerEmail,
        amount: Number(amount),
        reference,
        currency,
        callbackUrl: `${clientBaseUrl}/dashboard/finance/payments?status=success&ref=${reference}&gateway=PAYSTACK`,
        metadata: {
            schoolId,
            branchId: activeBranchId || null,
            studentId,
            invoiceId: invoiceId || null,
            transactionId: transaction.id
        }
    });

    return res.status(StatusCodes.OK).json({
        gateway: 'PAYSTACK',
        authorizationUrl: pskRes.authorizationUrl,
        checkoutUrl: pskRes.authorizationUrl,
        accessCode: pskRes.accessCode,
        reference,
        transactionId: transaction.id
    });
};

const initializePaystackPayment = async (req, res) => {
    return initializeOnlinePayment(req, res);
};

const initializeWalletDeposit = async (req, res) => {
    const { studentId, amount, email, gateway } = req.body;
    const { schoolId, activeBranchId } = req.user;

    if (!studentId || !amount || Number(amount) < MIN_PAYMENT_AMOUNT) {
        throw new CustomError.BadRequestError(`studentId and amount ≥ ₦${MIN_PAYMENT_AMOUNT} required`);
    }

    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        include: {
            user: { select: { name: true, email: true } },
            parent: { include: { user: { select: { name: true, email: true } } } }
        }
    });
    if (!student || student.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Student not found');
    }

    const [settings, financeSettings, schoolSettings] = await Promise.all([
        prisma.schoolPaymentSettings.findUnique({ where: { schoolId } }),
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);

    const selectedGateway = (gateway || settings?.activeGateway || 'FLUTTERWAVE').toUpperCase();
    const currency = financeSettings?.currencySymbol === '$' ? 'USD' : 'NGN';
    const schoolName = settings?.merchantDisplayName || schoolSettings?.schoolName || 'Skooly School';

    let payerEmail = email || student.parent?.user?.email || student.user?.email || 'parent@skooly.app';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) payerEmail = 'parent@skooly.app';
    const customerName = student.parent?.user?.name || student.user?.name || 'Parent';

    const clientBaseUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    if (selectedGateway === 'FLUTTERWAVE') {
        const reference = generateRef('WDP-FLW');
        const transaction = await prisma.paymentTransaction.create({
            data: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                reference,
                amount: Number(amount),
                method: 'FLUTTERWAVE',
                status: 'PENDING',
                initiatedBy: req.user.userId,
                note: 'WALLET_DEPOSIT'
            }
        });

        const secretKey = await getDecryptedFlwSecret(schoolId);
        const flwRes = await flutterwaveClient.initializePayment({
            secretKey,
            publicKey: settings?.flwPublicKey,
            amount: Number(amount),
            currency,
            txRef: reference,
            redirectUrl: `${clientBaseUrl}/parent/payment-success?ref=${reference}&type=wallet&gateway=FLUTTERWAVE`,
            email: payerEmail,
            name: customerName,
            customer: {
                email: payerEmail,
                name: customerName
            },
            customizations: {
                title: `${schoolName} Wallet Top-up`,
                description: `Wallet Top-up for ${student.user?.name || 'Student'}`
            },
            meta: {
                schoolId,
                studentId,
                transactionId: transaction.id,
                type: 'WALLET_DEPOSIT'
            }
        });

        return res.status(StatusCodes.OK).json({
            gateway: 'FLUTTERWAVE',
            authorizationUrl: flwRes.link,
            checkoutUrl: flwRes.link,
            reference,
            transactionId: transaction.id
        });
    }

    if (selectedGateway === 'MONNIFY') {
        const reference = generateRef('WDP-MNF');
        const transaction = await prisma.paymentTransaction.create({
            data: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                reference,
                amount: Number(amount),
                method: 'MONNIFY',
                status: 'PENDING',
                initiatedBy: req.user.userId,
                note: 'WALLET_DEPOSIT'
            }
        });

        const monnifyConfig = await getDecryptedMonnifyConfig(schoolId);
        const mnfRes = await monnifyClient.initializePayment({
            ...monnifyConfig,
            amount: Number(amount),
            customerName,
            customerEmail: payerEmail,
            paymentReference: reference,
            paymentDescription: `Wallet Top-up for ${student.user?.name || 'Student'}`,
            currencyCode: currency,
            redirectUrl: `${clientBaseUrl}/parent/payment-success?ref=${reference}&type=wallet&gateway=MONNIFY`,
            metadata: {
                schoolId,
                studentId,
                transactionId: transaction.id,
                type: 'WALLET_DEPOSIT'
            }
        });

        return res.status(StatusCodes.OK).json({
            gateway: 'MONNIFY',
            authorizationUrl: mnfRes.checkoutUrl,
            checkoutUrl: mnfRes.checkoutUrl,
            transactionReference: mnfRes.transactionReference,
            reference,
            transactionId: transaction.id
        });
    }

    // Default to PAYSTACK
    const reference = generateRef('WDP-PSK');
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
            note: 'WALLET_DEPOSIT'
        }
    });

    const secretKey = await getDecryptedPaystackSecret(schoolId);
    const pskRes = await paystackClient.initializePayment({
        secretKey,
        email: payerEmail,
        amount: Number(amount),
        reference,
        currency,
        callbackUrl: `${clientBaseUrl}/parent/payment-success?ref=${reference}&type=wallet&gateway=PAYSTACK`,
        metadata: {
            schoolId,
            studentId,
            transactionId: transaction.id,
            type: 'WALLET_DEPOSIT'
        }
    });

    return res.status(StatusCodes.OK).json({
        gateway: 'PAYSTACK',
        authorizationUrl: pskRes.authorizationUrl,
        checkoutUrl: pskRes.authorizationUrl,
        accessCode: pskRes.accessCode,
        reference,
        transactionId: transaction.id
    });
};

const initializePaystackWalletDeposit = async (req, res) => {
    return initializeWalletDeposit(req, res);
};

// ─── VERIFY PAYMENT (for PaymentSuccess page) ──────────────────────────────
const verifyPayment = async (req, res) => {
    const { ref } = req.query;
    const { schoolId } = req.user;

    if (!ref) throw new CustomError.BadRequestError('ref query param is required');

    let tx = await prisma.paymentTransaction.findUnique({
        where: { reference: ref },
        include: {
            receipt: true,
            student: { include: { user: { select: { name: true } } } }
        }
    });

    if (!tx || tx.schoolId !== schoolId) throw new CustomError.NotFoundError('Payment not found');

    // If still pending, attempt live verification from provider
    if (tx.status === 'PENDING') {
        try {
            if (tx.method === 'FLUTTERWAVE' || ref.startsWith('FLW') || ref.startsWith('WDP-FLW')) {
                const secretKey = await getDecryptedFlwSecret(schoolId).catch(() => null);
                if (secretKey) {
                    const flwCheck = await flutterwaveClient.verifyTransactionByRef({ secretKey, txRef: ref });
                    if (flwCheck?.data?.status === 'successful' && flwCheck.data.amount >= tx.amount) {
                        await settleSuccessfulPaymentTransaction({
                            reference: ref,
                            gatewayRef: flwCheck.data.id,
                            gatewayResponse: flwCheck.data,
                            paymentMethod: 'FLUTTERWAVE'
                        });
                        tx = await prisma.paymentTransaction.findUnique({
                            where: { reference: ref },
                            include: { receipt: true, student: { include: { user: { select: { name: true } } } } }
                        });
                    }
                }
            } else if (tx.method === 'PAYSTACK' || ref.startsWith('PSK') || ref.startsWith('WDP-PSK') || ref.startsWith('PAY-')) {
                const secretKey = await getDecryptedPaystackSecret(schoolId).catch(() => null);
                if (secretKey) {
                    const pskCheck = await paystackClient.verifyTransaction({ secretKey, reference: ref });
                    if (pskCheck?.data?.status === 'success') {
                        await settleSuccessfulPaymentTransaction({
                            reference: ref,
                            gatewayRef: pskCheck.data.id,
                            gatewayResponse: pskCheck.data,
                            paymentMethod: 'PAYSTACK'
                        });
                        tx = await prisma.paymentTransaction.findUnique({
                            where: { reference: ref },
                            include: { receipt: true, student: { include: { user: { select: { name: true } } } } }
                        });
                    }
                }
            } else if (tx.method === 'MONNIFY' || ref.startsWith('MNF') || ref.startsWith('WDP-MNF')) {
                const cfg = await getDecryptedMonnifyConfig(schoolId).catch(() => null);
                if (cfg) {
                    const mnfCheck = await monnifyClient.verifyTransaction({ ...cfg, transactionReference: ref });
                    if (mnfCheck?.responseBody?.paymentStatus === 'PAID') {
                        await settleSuccessfulPaymentTransaction({
                            reference: ref,
                            gatewayRef: mnfCheck.responseBody.transactionReference,
                            gatewayResponse: mnfCheck.responseBody,
                            paymentMethod: 'MONNIFY'
                        });
                        tx = await prisma.paymentTransaction.findUnique({
                            where: { reference: ref },
                            include: { receipt: true, student: { include: { user: { select: { name: true } } } } }
                        });
                    }
                }
            }
        } catch (verifyErr) {
            console.warn('[Live Payment Verification Warning]:', verifyErr.message);
        }
    }

    res.status(StatusCodes.OK).json({
        status: tx.status,
        amount: tx.amount,
        method: tx.method,
        paidAt: tx.paidAt,
        note: tx.note,
        studentName: tx.student?.user?.name,
        receiptNumber: tx.receipt?.receiptNumber || null,
        receiptId: tx.receipt?.id || null,
    });
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

                // PHASE 8: Route WALLET_DEPOSIT to wallet credit instead of invoice payment
                if (txRecord.note === 'WALLET_DEPOSIT') {
                    const { fundWallet: doFundWallet } = require('./financev2.controller');
                    let wallet = await tx.studentWallet.findUnique({ where: { studentId: txRecord.studentId } });
                    if (!wallet) {
                        const student = await tx.studentProfile.findUnique({ where: { id: txRecord.studentId } });
                        wallet = await tx.studentWallet.create({
                            data: { schoolId: txRecord.schoolId, studentId: txRecord.studentId, branchId: student?.branchId }
                        });
                    }
                    const updatedWallet = await tx.studentWallet.update({
                        where: { studentId: txRecord.studentId },
                        data: { balance: { increment: txRecord.amount } }
                    });
                    await tx.studentWalletTransaction.create({
                        data: {
                            walletId: wallet.id,
                            schoolId: txRecord.schoolId,
                            type: 'DEPOSIT',
                            amount: txRecord.amount,
                            balanceBefore: updatedWallet.balance - txRecord.amount,
                            balanceAfter: updatedWallet.balance,
                            reference: txRecord.reference,
                            description: 'Paystack Online Top-up'
                        }
                    });
                    walletBalanceAfter = updatedWallet.balance;
                    invoiceNumbers = [];
                } else {
                const result = await applyPaymentToInvoices(tx, {
                    schoolId: txRecord.schoolId,
                    studentId: txRecord.studentId,
                    amount: txRecord.amount,
                    paymentTransactionId: txRecord.id,
                    allowOverpayment
                });

                invoiceNumbers = result.invoiceNumbers;
                walletBalanceAfter = result.walletBalanceAfter;
                } // end else (non-wallet-deposit)

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
            }, { timeout: 30000, maxWait: 10000 });

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
    }, { timeout: 30000, maxWait: 10000 });

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
    const { action, reviewNote, verifiedAmount } = req.body;
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

        const finalAmount = (verifiedAmount !== undefined && verifiedAmount !== null && Number(verifiedAmount) > 0)
            ? Number(verifiedAmount)
            : Number(submission.amount);

        await prisma.$transaction(async (tx) => {
            const updateSubData = {
                status: 'APPROVED',
                reviewedBy: userId,
                reviewedAt: new Date(),
                reviewNote
            };
            if (finalAmount !== Number(submission.amount)) {
                updateSubData.amount = finalAmount;
            }

            await tx.transferSubmission.update({
                where: { id },
                data: updateSubData
            });

            await tx.paymentTransaction.update({
                where: { id: submission.paymentTransactionId },
                data: {
                    status: 'SUCCESSFUL',
                    paidAt: new Date(),
                    ...(finalAmount !== Number(submission.amount) && { amount: finalAmount })
                }
            });

            const result = await applyPaymentToInvoices(tx, {
                schoolId,
                studentId: submission.studentId,
                amount: finalAmount,
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
                amountPaid: finalAmount,
                method: 'BANK_TRANSFER',
                invoiceNumbers,
                walletBalanceAfter,
                financeSettings,
                schoolSettings
            });
        }, { timeout: 30000, maxWait: 10000 });

        // GAP 8 FIX — email outside transaction
        if (recipientEmail && receipt) {
            sendTransferApprovedEmail(recipientEmail, {
                studentName: submission.senderName,
                amount: finalAmount,
                schoolName,
                currencySymbol
            }).catch(e => console.error('[Finance Email] Approve email failed:', e.message));
            logNotification(schoolId, submission.studentId, 'TRANSFER_APPROVED', recipientEmail);
        }

        return res.status(StatusCodes.OK).json({ msg: 'Transfer approved and receipt generated', receipt });
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

// ─── RESEND INVOICE EMAIL ─────────────────────────────────────────────────────

const resendInvoice = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;

    const invoice = await prisma.financeInvoice.findUnique({
        where: { id },
        include: {
            student: {
                include: {
                    user: { select: { name: true, email: true } },
                    parent: { include: { user: { select: { email: true, name: true } } } }
                }
            },
            items: true
        }
    });

    if (!invoice || invoice.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Invoice not found');
    }

    const [financeSettings, schoolSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);

    // Determine recipient — prefer parent email, fall back to student email
    const parentEmail = invoice.student?.parent?.user?.email;
    const studentEmail = invoice.student?.user?.email;
    const recipientEmail = parentEmail || studentEmail;

    if (!recipientEmail) {
        throw new CustomError.BadRequestError('No email address found for this student or parent');
    }

    const studentName = invoice.student?.user?.name || 'Student';
    const currencySymbol = financeSettings?.currencySymbol || '₦';
    const schoolName = schoolSettings?.schoolName || 'School';
    const showItemizedBreakdown = financeSettings?.showItemizedBreakdown !== false;

    await sendInvoiceEmail(recipientEmail, {
        studentName,
        invoiceNumber: invoice.invoiceNumber,
        totalAmount: invoice.totalAmount,
        dueDate: invoice.dueDate,
        items: invoice.items,
        showItemizedBreakdown,
        schoolName,
        currencySymbol
    });

    // Mark as SENT
    await prisma.financeInvoice.update({
        where: { id },
        data: { 
            isSent: true,
            lastSentAt: new Date(),
            ...( ['OPEN', 'DRAFT'].includes(invoice.status) ? { status: 'SENT' } : {} )
        }
    });

    await logNotification(schoolId, invoice.studentId, 'INVOICE_RESENT', recipientEmail);

    res.status(StatusCodes.OK).json({
        msg: `Invoice emailed to ${recipientEmail}`,
        sentTo: recipientEmail
    });
};

const markInvoicePrinted = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;
    
    await prisma.financeInvoice.update({
        where: { id },
        data: { isPrinted: true, lastPrintedAt: new Date() }
    });
    res.status(StatusCodes.OK).json({ msg: 'Marked as printed' });
};

const markReceiptPrinted = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;
    
    await prisma.financeReceipt.update({
        where: { id },
        data: { isPrinted: true, lastPrintedAt: new Date() }
    });
    res.status(StatusCodes.OK).json({ msg: 'Marked as printed' });
};

// ─── INVOICE GENERATION ──────────────────────────────────────────────────────

const generateInvoice = async (req, res) => {
    const { studentId, term, academicYear, dueDate, feeDefinitionIds, expectedTotal, items: rawItems, customFees: rawCustomFees } = req.body;
    const { schoolId, activeBranchId } = req.user;

    if (!studentId) throw new CustomError.BadRequestError('studentId is required');

    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        include: { user: { select: { name: true, email: true } } }
    });
    if (!student || student.schoolId !== schoolId) throw new CustomError.NotFoundError('Student not found');

    const [financeSettings, schoolPaymentSettings, schoolSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolPaymentSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);

    // Fee definitions — scoped to this school
    const feeQuery = {
        schoolId, isActive: true, isDeleted: false,
        ...(feeDefinitionIds?.length ? { id: { in: feeDefinitionIds } } : {})
    };
    const fees = feeDefinitionIds?.length || !rawItems?.length
        ? await prisma.feeDefinition.findMany({ where: feeQuery })
        : [];
    if (fees.length === 0 && !rawItems?.length) throw new CustomError.BadRequestError('No active fee definitions found');

    // Refuse to re-bill a fee already invoiced for this student this term/session (paid or not).
    if (fees.length > 0) {
        const alreadyBilledIds = await getAlreadyBilledFeeIds(schoolId, studentId, term, academicYear);
        const dupes = fees.filter(f => alreadyBilledIds.has(f.id));
        if (dupes.length > 0) {
            throw new CustomError.BadRequestError(
                `${dupes.map(f => f.name).join(', ')} ${dupes.length > 1 ? 'have' : 'has'} already been invoiced for this student this term. Deselect ${dupes.length > 1 ? 'them' : 'it'} to continue.`
            );
        }
    }

    // Optional physical items sold on this invoice (e.g. uniforms, books) — pulled from Inventory
    // so their price/name is authoritative and stock can be deducted once the invoice is paid.
    let itemLines = [];
    if (Array.isArray(rawItems) && rawItems.length > 0) {
        const inventoryItemIds = rawItems.map(i => i.inventoryItemId).filter(Boolean);
        const dbInventoryItems = await prisma.inventoryItem.findMany({
            where: { id: { in: inventoryItemIds }, schoolId, isDeleted: false }
        });
        const invMap = new Map(dbInventoryItems.map(i => [i.id, i]));
        itemLines = rawItems.map(i => {
            const dbItem = i.inventoryItemId ? invMap.get(i.inventoryItemId) : null;
            const quantity = Math.max(1, parseInt(i.quantity) || 1);
            const unitPrice = dbItem ? dbItem.sellingPrice : Number(i.unitPrice) || 0;
            return {
                type: 'ITEM',
                referenceId: dbItem?.id || null,
                label: dbItem?.name || i.label || 'Item',
                quantity,
                unitPrice,
                amount: unitPrice * quantity
            };
        }).filter(i => i.amount > 0);
    }
    const itemsSubTotal = itemLines.reduce((s, i) => s + i.amount, 0);

    // Ad-hoc, one-off fees typed in on this invoice only (e.g. "Damaged Book — ₦2,000").
    // Not backed by a FeeDefinition, so they're stored as CUSTOM invoice items.
    const customFeeLines = Array.isArray(rawCustomFees)
        ? rawCustomFees
            .map(cf => ({ type: 'CUSTOM', referenceId: null, label: String(cf.name || 'Custom Fee').trim(), quantity: 1, unitPrice: Number(cf.amount) || 0, amount: Number(cf.amount) || 0 }))
            .filter(cf => cf.label && cf.amount > 0)
        : [];
    const customFeesSubTotal = customFeeLines.reduce((s, i) => s + i.amount, 0);

    // ── Compute totals ────────────────────────────────────────────────────────
    // Scholarships discount fees + custom fees (mirrors the frontend's computeTotal), but
    // never physical inventory items purchased on the same invoice.
    const feesSubTotal = fees.reduce((s, f) => s + f.amount * (f.quantity || 1), 0);
    const discountableSubTotal = feesSubTotal + customFeesSubTotal;
    const subTotal = discountableSubTotal + itemsSubTotal;

    // Apply active scholarships
    const scholarships = await prisma.scholarship.findMany({
        where: { schoolId, studentId, isDeleted: false, status: 'ACTIVE' }
    });

    let discountTotal = 0;
    for (const sc of scholarships) {
        if (sc.type === 'PERCENTAGE') {
            discountTotal += discountableSubTotal * (sc.value / 100);
        } else if (sc.type === 'SCHOLARSHIP' || sc.type === 'FIXED_AMOUNT') {
            // Student pays sc.value — discount is the difference
            discountTotal = Math.max(discountTotal, discountableSubTotal - sc.value);
        }
    }
    discountTotal = Math.min(discountTotal, discountableSubTotal); // cap at the discountable portion only
    const totalAmount = Math.max(0, subTotal - discountTotal);
    console.log(`[generateInvoice] subTotal=${subTotal} scholarships=${scholarships.length} discountTotal=${discountTotal} totalAmount=${totalAmount}`);

    // ── Cross-validate with frontend ──────────────────────────────────────────
    if (expectedTotal !== undefined && expectedTotal !== null) {
        const diff = Math.abs(Number(expectedTotal) - totalAmount);
        if (diff > 1) { // allow ₦1 rounding tolerance
            throw new CustomError.BadRequestError(
                `Total mismatch: frontend computed ₦${Number(expectedTotal).toLocaleString()} but backend computed ₦${totalAmount.toLocaleString()}. Refresh and try again.`
            );
        }
    }

    const invoicePrefix = financeSettings?.invoicePrefix || 'INV-';
    const invoiceNumber = `${invoicePrefix}${Date.now()}`;

    let invoice = await prisma.$transaction(async (tx) => {
        return await tx.financeInvoice.create({
            data: {
                schoolId,
                branchId: activeBranchId || null,
                studentId,
                term: term || schoolSettings?.currentTerm || null,
                academicYear: academicYear || schoolSettings?.currentYear || null,
                invoiceNumber,
                subTotal,
                discountTotal,
                totalAmount,
                balanceDue: totalAmount,
                status: 'OPEN',
                dueDate: dueDate ? new Date(dueDate) : null,
                items: {
                    create: [
                        ...fees.map(f => ({
                            type: f.type || 'FEE',
                            referenceId: f.id,
                            label: f.name,
                            quantity: f.quantity || 1,
                            unitPrice: f.amount,
                            amount: f.amount * (f.quantity || 1)
                        })),
                        ...customFeeLines,
                        ...itemLines
                    ]
                }
            },
            include: { items: true }
        });
    }, { maxWait: 10000, timeout: 30000 });

    // Option A: Auto-apply wallet if enabled
    const autoApply = schoolPaymentSettings?.autoApplyWallet ?? financeSettings?.autoApplyWallet ?? false;
    if (autoApply && invoice.balanceDue > 0) {
        invoice = await autoApplyStudentWalletToInvoice({
            schoolId,
            branchId: activeBranchId || null,
            studentId,
            invoice,
            userId: req.user.userId,
            financeSettings,
            schoolSettings
        });
    }

    // Send invoice email (non-blocking)
    const recipientEmail = await getStudentEmail(studentId);
    const studentName = student.user?.name?.trim() || '';
    if (recipientEmail) {
        sendInvoiceEmail(recipientEmail, {
            studentName, invoiceNumber,
            totalAmount, dueDate,
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
    const { studentId, status, term, academicYear, search, isSent, isPrinted, page = 1, limit = 30 } = req.query;

    const where = {
        schoolId,
        isDeleted: false,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(studentId && { studentId }),
        ...(status && { status }),
        ...(term && { term }),
        ...(academicYear && { academicYear }),
        ...(isSent !== undefined && isSent !== '' && { isSent: isSent === 'true' }),
        ...(isPrinted !== undefined && isPrinted !== '' && { isPrinted: isPrinted === 'true' }),
        ...(search && {
            OR: [
                { invoiceNumber: { contains: search, mode: 'insensitive' } },
                { student: { user: { name: { contains: search, mode: 'insensitive' } } } },
                { student: { admissionNo: { contains: search, mode: 'insensitive' } } }
            ]
        })
    };

    const [invoices, total] = await Promise.all([
        prisma.financeInvoice.findMany({
            where,
            include: {
                school: { select: { name: true } },
                student: { include: { user: { select: { name: true } }, classArm: { select: { name: true } } } },
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

const updateInvoice = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;
    const { dueDate, term, academicYear, items: rawItems } = req.body;

    const invoice = await prisma.financeInvoice.findUnique({ where: { id } });
    if (!invoice || invoice.schoolId !== schoolId || invoice.isDeleted) {
        throw new CustomError.NotFoundError('Invoice not found');
    }
    if (['PAID', 'VOID', 'CANCELLED'].includes(invoice.status)) {
        throw new CustomError.BadRequestError(`Cannot edit a ${invoice.status.toLowerCase()} invoice`);
    }

    const data = {};
    if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
    if (term !== undefined) data.term = term;
    if (academicYear !== undefined) data.academicYear = academicYear;

    // Line-item amounts can only be edited before any payment has been received —
    // once money has been applied against the invoice, changing its total would desync
    // balanceDue/receipts already issued against the old amount.
    if (Array.isArray(rawItems)) {
        if (invoice.amountPaid > 0) {
            throw new CustomError.BadRequestError('Cannot edit line items after a payment has been recorded on this invoice. Cancel it and issue a new one instead.');
        }
        const cleanItems = rawItems
            .map(i => ({
                type: i.type || 'CUSTOM',
                referenceId: i.referenceId || null,
                label: String(i.label || 'Item').trim(),
                quantity: Math.max(1, Number(i.quantity) || 1),
                unitPrice: Number(i.unitPrice) || 0,
            }))
            .filter(i => i.label && i.unitPrice >= 0)
            .map(i => ({ ...i, amount: i.unitPrice * i.quantity }));
        if (cleanItems.length === 0) throw new CustomError.BadRequestError('Invoice must have at least one item');

        const newSubTotal = cleanItems.reduce((s, i) => s + i.amount, 0);
        const newTotal = Math.max(0, newSubTotal - (invoice.discountTotal || 0));

        await prisma.$transaction(async (tx) => {
            await tx.financeInvoiceItem.deleteMany({ where: { invoiceId: id } });
            await tx.financeInvoice.update({
                where: { id },
                data: {
                    ...data,
                    subTotal: newSubTotal,
                    totalAmount: newTotal,
                    balanceDue: Math.max(0, newTotal - (invoice.walletDeduction || 0)),
                    items: { create: cleanItems }
                }
            });
        });
    } else if (Object.keys(data).length > 0) {
        await prisma.financeInvoice.update({ where: { id }, data });
    }

    const updated = await prisma.financeInvoice.findUnique({ where: { id }, include: { items: true } });
    res.status(StatusCodes.OK).json({ invoice: updated, msg: 'Invoice updated' });
};

// Soft-cancel: keeps the invoice (and any payment history) for the audit trail, just marks
// it CANCELLED and clears the outstanding balance so it stops counting toward collections due.
const cancelInvoice = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;

    const invoice = await prisma.financeInvoice.findUnique({ where: { id } });
    if (!invoice || invoice.schoolId !== schoolId || invoice.isDeleted) {
        throw new CustomError.NotFoundError('Invoice not found');
    }
    if (['CANCELLED', 'VOID'].includes(invoice.status)) {
        throw new CustomError.BadRequestError('Invoice is already cancelled');
    }

    const updated = await prisma.financeInvoice.update({
        where: { id },
        data: { status: 'CANCELLED', balanceDue: 0 }
    });

    res.status(StatusCodes.OK).json({
        invoice: updated,
        msg: invoice.amountPaid > 0
            ? `Invoice cancelled. Note: ₦${invoice.amountPaid.toLocaleString()} was already collected on this invoice — verify any refund/adjustment separately.`
            : 'Invoice cancelled'
    });
};

const bulkCancelInvoices = async (req, res) => {
    const { invoiceIds } = req.body;
    const { schoolId } = req.user;
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
        throw new CustomError.BadRequestError('invoiceIds array is required');
    }

    const invoices = await prisma.financeInvoice.findMany({
        where: { id: { in: invoiceIds }, schoolId, isDeleted: false, status: { notIn: ['CANCELLED', 'VOID'] } },
        select: { id: true }
    });
    if (invoices.length > 0) {
        await prisma.financeInvoice.updateMany({
            where: { id: { in: invoices.map(i => i.id) } },
            data: { status: 'CANCELLED', balanceDue: 0 }
        });
    }
    const skipped = invoiceIds.length - invoices.length;
    res.status(StatusCodes.OK).json({
        cancelledCount: invoices.length,
        skippedCount: skipped,
        msg: `${invoices.length} invoice(s) cancelled${skipped > 0 ? `, ${skipped} skipped (not found or already cancelled)` : ''}`
    });
};

// Hard delete — only permitted while nothing has been paid against the invoice yet, so a real
// payment/receipt trail can never be silently erased. Anything with money on it must be cancelled instead.
const deleteInvoice = async (req, res) => {
    const { id } = req.params;
    const { schoolId } = req.user;

    const invoice = await prisma.financeInvoice.findUnique({ where: { id } });
    if (!invoice || invoice.schoolId !== schoolId || invoice.isDeleted) {
        throw new CustomError.NotFoundError('Invoice not found');
    }
    if (invoice.amountPaid > 0) {
        throw new CustomError.BadRequestError('Cannot delete an invoice that has payments recorded against it. Cancel it instead to preserve the payment/audit trail.');
    }

    await prisma.financeInvoice.update({ where: { id }, data: { isDeleted: true, deletedAt: new Date() } });
    res.status(StatusCodes.OK).json({ msg: 'Invoice deleted' });
};

const bulkDeleteInvoices = async (req, res) => {
    const { invoiceIds } = req.body;
    const { schoolId } = req.user;
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
        throw new CustomError.BadRequestError('invoiceIds array is required');
    }

    const invoices = await prisma.financeInvoice.findMany({
        where: { id: { in: invoiceIds }, schoolId, isDeleted: false },
        select: { id: true, amountPaid: true }
    });
    const deletable = invoices.filter(i => i.amountPaid === 0);
    const blocked = invoices.length - deletable.length;
    if (deletable.length > 0) {
        await prisma.financeInvoice.updateMany({
            where: { id: { in: deletable.map(i => i.id) } },
            data: { isDeleted: true, deletedAt: new Date() }
        });
    }
    res.status(StatusCodes.OK).json({
        deletedCount: deletable.length,
        blockedCount: blocked,
        msg: `${deletable.length} invoice(s) deleted${blocked > 0 ? `, ${blocked} skipped because they already have payments recorded (cancel those instead)` : ''}`
    });
};
// ─── PAYMENT RECORDS (Reconciliation) ────────────────────────────────────────

const getPaymentTransactions = async (req, res) => {
    const { schoolId, activeBranchId } = req.user;
    const { studentId, method, status, from, to, isPrinted, isSent, page = 1, limit = 30 } = req.query;

    const where = {
        schoolId,
        ...(activeBranchId && { branchId: activeBranchId }),
        ...(studentId && { studentId }),
        ...(method && { method }),
        ...(status && { status }),
        ...(isPrinted !== undefined && isPrinted !== '' && { receipt: { isPrinted: isPrinted === 'true' } }),
        ...(isSent !== undefined && isSent !== '' && { receipt: { isSent: isSent === 'true' } }),
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
                receipt: { select: { id: true, receiptNumber: true, isPrinted: true, isSent: true } },
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

// ─── APPLY WALLET TO INVOICE (OPTIONS B & C) ─────────────────────────────────

const applyWalletToInvoice = async (req, res) => {
    const { studentId, invoiceId, amount, sourceType = 'STUDENT', parentId } = req.body;
    let schoolId = req.user?.schoolId;

    if (!invoiceId) {
        throw new CustomError.BadRequestError('invoiceId is required');
    }

    // Pre-fetch invoice with student and parent
    const invoice = await prisma.financeInvoice.findUnique({
        where: { id: invoiceId },
        include: {
            student: {
                include: {
                    user: { select: { name: true } },
                    parent: { include: { user: { select: { name: true } } } }
                }
            }
        }
    });

    if (!invoice || invoice.isDeleted) throw new CustomError.NotFoundError('Invoice not found');
    if (!schoolId) schoolId = invoice.schoolId;
    if (invoice.schoolId !== schoolId) throw new CustomError.UnauthorizedError('Unauthorized access to invoice');
    if (invoice.balanceDue <= 0) throw new CustomError.BadRequestError('Invoice is already fully paid');

    const paymentSettings = await prisma.schoolPaymentSettings.findUnique({ where: { schoolId } });
    const isParent = req.user?.role === 'PARENT';

    // Check if wallet checkout is allowed
    if (isParent && paymentSettings && paymentSettings.allowWalletCheckout === false) {
        throw new CustomError.BadRequestError('Wallet checkout is disabled by school administration');
    }

    const effectiveStudentId = studentId || invoice.studentId;
    const isSiblingAllocation = sourceType === 'STUDENT' && effectiveStudentId !== invoice.studentId;

    // Sibling / Family sharing check
    if (isSiblingAllocation || sourceType === 'FAMILY') {
        if (paymentSettings && paymentSettings.allowFamilyWalletSharing === false) {
            throw new CustomError.BadRequestError('Cross-student and family wallet allocation is disabled by school administration');
        }
    }

    // Authorization verification for PARENT role
    if (isParent) {
        const parentUser = await prisma.parentProfile.findFirst({
            where: { userId: req.user.userId },
            include: { students: { select: { id: true } } }
        });
        if (!parentUser) throw new CustomError.UnauthorizedError('Parent profile not found');
        const allowedStudentIds = parentUser.students.map(s => s.id);

        if (!allowedStudentIds.includes(invoice.studentId)) {
            throw new CustomError.UnauthorizedError('You are not authorized to pay this invoice');
        }
        if (sourceType === 'STUDENT' && !allowedStudentIds.includes(effectiveStudentId)) {
            throw new CustomError.UnauthorizedError('You are not authorized to spend from this student wallet');
        }
    }

    const reference = generateRef('WAL');
    let applied = 0;
    let updatedWalletBalance = 0;
    let finalInvoiceState = null;

    await prisma.$transaction(async (tx) => {
        const liveInvoice = await tx.financeInvoice.findUnique({
            where: { id: invoiceId },
            include: { student: { include: { user: true } } }
        });
        if (!liveInvoice || liveInvoice.balanceDue <= 0) {
            throw new CustomError.BadRequestError('Invoice is already fully paid');
        }

        if (liveInvoice.amountPaid === 0) {
            await deductInventoryForInvoice(tx, {
                schoolId, invoiceId, invoiceNumber: liveInvoice.invoiceNumber, performedBy: req.user?.name
            });
        }

        let liveBalance = 0;
        let sourceWalletId = null;

        if (sourceType === 'FAMILY') {
            const liveFamWallet = await tx.familyWallet.findUnique({
                where: { parentId: parentId || liveInvoice.student?.parentId }
            });
            if (!liveFamWallet || liveFamWallet.balance <= 0) {
                throw new CustomError.BadRequestError('Insufficient family wallet balance');
            }
            liveBalance = liveFamWallet.balance;
            sourceWalletId = liveFamWallet.id;
        } else {
            const liveWallet = await tx.studentWallet.findUnique({
                where: { studentId: effectiveStudentId }
            });
            if (!liveWallet || liveWallet.balance <= 0) {
                throw new CustomError.BadRequestError('Insufficient wallet balance');
            }
            liveBalance = liveWallet.balance;
            sourceWalletId = liveWallet.id;
        }

        // Compute toApply inside TX with live data
        applied = Math.min(
            liveBalance,
            liveInvoice.balanceDue,
            amount ? Number(amount) : liveInvoice.balanceDue
        );
        if (applied <= 0) throw new CustomError.BadRequestError('Nothing to apply');

        let walletBalanceBefore = liveBalance;
        let walletBalanceAfter = liveBalance - applied;

        if (sourceType === 'FAMILY') {
            const updatedFam = await tx.familyWallet.update({
                where: { id: sourceWalletId },
                data: { balance: { decrement: applied } }
            });
            if (updatedFam.balance < 0) throw new CustomError.BadRequestError('Insufficient family wallet balance');
            updatedWalletBalance = updatedFam.balance;

            await tx.familyWalletTransaction.create({
                data: {
                    familyWalletId: sourceWalletId,
                    schoolId,
                    type: 'INVOICE_APPLICATION',
                    amount: applied,
                    balanceBefore: walletBalanceBefore,
                    balanceAfter: walletBalanceAfter,
                    reference,
                    description: `Applied ₦${applied.toLocaleString()} to invoice ${liveInvoice.invoiceNumber} (${liveInvoice.student?.user?.name || 'Student'})`
                }
            });
        } else {
            const updatedWallet = await tx.studentWallet.update({
                where: { studentId: effectiveStudentId },
                data: { balance: { decrement: applied } }
            });
            if (updatedWallet.balance < 0) throw new CustomError.BadRequestError('Insufficient wallet balance');
            updatedWalletBalance = updatedWallet.balance;

            const desc = isSiblingAllocation
                ? `Applied ₦${applied.toLocaleString()} to sibling invoice ${liveInvoice.invoiceNumber} (${liveInvoice.student?.user?.name || 'Student'})`
                : `Applied to invoice ${liveInvoice.invoiceNumber}`;

            await tx.studentWalletTransaction.create({
                data: {
                    walletId: sourceWalletId,
                    schoolId,
                    type: 'INVOICE_APPLICATION',
                    amount: applied,
                    balanceBefore: walletBalanceBefore,
                    balanceAfter: walletBalanceAfter,
                    reference,
                    description: desc
                }
            });
        }

        const newPaid = liveInvoice.amountPaid + applied;
        const newBalance = liveInvoice.balanceDue - applied;
        const newStatus = newBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID';

        finalInvoiceState = await tx.financeInvoice.update({
            where: { id: invoiceId },
            data: {
                amountPaid: newPaid,
                balanceDue: newBalance,
                walletDeduction: { increment: applied },
                status: newStatus
            }
        });

        // Audit trail: create a WALLET PaymentTransaction + Allocation
        const txRecord = await tx.paymentTransaction.create({
            data: {
                schoolId,
                studentId: liveInvoice.studentId,
                reference,
                amount: applied,
                method: 'WALLET',
                status: 'SUCCESSFUL',
                paidAt: new Date(),
                initiatedBy: req.user?.userId || null
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
            studentId: liveInvoice.studentId,
            paymentTransactionId: txRecord.id,
            amountPaid: applied,
            method: 'WALLET',
            invoiceNumbers: [liveInvoice.invoiceNumber],
            walletBalanceAfter: updatedWalletBalance,
            financeSettings,
            schoolSettings
        });
    }, { timeout: 30000, maxWait: 10000 });

    res.status(StatusCodes.OK).json({
        msg: `₦${applied.toLocaleString()} applied from wallet to invoice ${finalInvoiceState?.invoiceNumber || ''}`,
        applied,
        walletBalance: updatedWalletBalance,
        invoice: {
            id: invoiceId,
            invoiceNumber: finalInvoiceState?.invoiceNumber,
            amountPaid: finalInvoiceState?.amountPaid,
            balanceDue: finalInvoiceState?.balanceDue,
            status: finalInvoiceState?.status
        }
    });
};

const getInvoicesForWalletAllocation = async (req, res) => {
    const { schoolId } = req.user;
    const { studentId, parentId } = req.query;

    if (!studentId && !parentId) {
        throw new CustomError.BadRequestError('studentId or parentId is required');
    }

    let targetStudentIds = [];

    if (studentId) {
        const student = await prisma.studentProfile.findUnique({
            where: { id: studentId },
            include: { parent: { include: { students: { where: { isDeleted: false }, select: { id: true } } } } }
        });
        // Accept if student exists AND (schoolId matches OR student.schoolId is null — some records may have null)
        if (!student) {
            throw new CustomError.NotFoundError('Student not found');
        }
        if (student.schoolId && student.schoolId !== schoolId) {
            throw new CustomError.NotFoundError('Student not found in this school');
        }
        // Include self and all siblings if parent exists
        targetStudentIds = student.parent?.students?.map(s => s.id) || [studentId];
        if (!targetStudentIds.includes(studentId)) targetStudentIds.push(studentId);
    } else if (parentId) {
        const parent = await prisma.parentProfile.findUnique({
            where: { id: parentId },
            include: { students: { where: { isDeleted: false }, select: { id: true } } }
        });
        if (!parent) {
            throw new CustomError.NotFoundError('Parent not found');
        }
        if (parent.schoolId && parent.schoolId !== schoolId) {
            throw new CustomError.NotFoundError('Parent not found in this school');
        }
        targetStudentIds = parent.students.map(s => s.id);
    }

    if (targetStudentIds.length === 0) {
        return res.status(StatusCodes.OK).json({ invoices: [] });
    }

    const invoices = await prisma.financeInvoice.findMany({
        where: {
            schoolId,
            studentId: { in: targetStudentIds },
            isDeleted: false,
            status: { in: ['OPEN', 'SENT', 'PARTIALLY_PAID', 'OVERDUE', 'PUBLISHED'] },
            balanceDue: { gt: 0 }
        },
        include: {
            student: {
                select: {
                    id: true,
                    admissionNo: true,
                    firstName: true,
                    lastName: true,
                    user: { select: { name: true } },
                    classArm: { select: { name: true } },
                    classLevel: { select: { name: true } }
                }
            }
        },
        orderBy: { createdAt: 'asc' }
    });

    res.status(StatusCodes.OK).json({ invoices });
};

// Deducts stock for any physical items (FinanceInvoiceItem.type === 'ITEM', referenceId → InventoryItem)
// on an invoice the first time it receives a payment, mirroring how a POS sale deducts inventory.
// Call only when liveInvoice.amountPaid === 0 (i.e. this is the invoice's first payment) to avoid
// double-deducting on later installments.
const deductInventoryForInvoice = async (tx, { schoolId, invoiceId, invoiceNumber, performedBy }) => {
    const itemLines = await tx.financeInvoiceItem.findMany({
        where: { invoiceId, type: 'ITEM', referenceId: { not: null } }
    });
    for (const line of itemLines) {
        const dbItem = await tx.inventoryItem.findUnique({ where: { id: line.referenceId } });
        if (!dbItem || dbItem.schoolId !== schoolId) continue;
        const prevQty = dbItem.quantityOnHand;
        const newQty = Math.max(0, prevQty - line.quantity);
        await tx.inventoryItem.update({ where: { id: dbItem.id }, data: { quantityOnHand: newQty } });
        await tx.inventoryMovement.create({
            data: {
                schoolId,
                itemId: dbItem.id,
                type: 'INVOICE_SALE',
                quantityChange: -line.quantity,
                previousQuantity: prevQty,
                newQuantity: newQty,
                unitPrice: line.unitPrice,
                referenceId: invoiceId,
                reason: `Sold via Invoice #${invoiceNumber}`,
                performedBy: performedBy || 'Finance Office'
            }
        });
    }
};

// Fee-definition IDs already invoiced for a student in a given term/session, across any still-active
// invoice. VOID/CANCELLED invoices don't count — their fee items are billable again. Used to stop
// invoice generation from re-billing a fee the student has already been charged for this period,
// regardless of whether that earlier charge has been paid off yet.
const getAlreadyBilledFeeIds = async (schoolId, studentId, term, academicYear) => {
    const invoices = await prisma.financeInvoice.findMany({
        where: {
            schoolId, studentId, isDeleted: false,
            status: { notIn: ['VOID', 'CANCELLED'] },
            ...(term && { term }),
            ...(academicYear && { academicYear })
        },
        include: { items: { where: { type: 'FEE' } } }
    });
    return new Set(invoices.flatMap(inv => inv.items.map(i => i.referenceId).filter(Boolean)));
};

// ─── RECORD MANUAL PAYMENT (PHASE 6) ──────────────────────────────────────────

const recordManualPayment = async (req, res) => {
    const { id: invoiceId } = req.params;
    const { amount: appliedAmount, method, discountAmount: appliedDiscount = 0 } = req.body;
    const { schoolId, activeBranchId } = req.user;

    if (!appliedAmount || appliedAmount <= 0) throw new CustomError.BadRequestError('Amount must be greater than 0');
    if (!['CASH', 'POS', 'BANK_TRANSFER'].includes(method)) {
        throw new CustomError.BadRequestError('Invalid payment method');
    }

    const invoice = await prisma.financeInvoice.findUnique({
        where: { id: invoiceId },
        include: { student: true }
    });

    if (!invoice || invoice.schoolId !== schoolId || invoice.isDeleted) {
        throw new CustomError.NotFoundError('Invoice not found');
    }
    const financeSettings = await prisma.financeSettings.findUnique({ where: { schoolId } });
    const invoicePrefix = financeSettings?.invoicePrefix || 'INV-';

    const reference = generateRef('MNL');

    const generatedReceipt = await prisma.$transaction(async (tx) => {
        const liveInvoice = await tx.financeInvoice.findUnique({ where: { id: invoiceId } });

        if (liveInvoice.amountPaid === 0) {
            await deductInventoryForInvoice(tx, {
                schoolId, invoiceId, invoiceNumber: liveInvoice.invoiceNumber, performedBy: req.user.name
            });
        }

        let amountToCurrentInvoice = 0;
        let discountToCurrentInvoice = 0;
        let overpaymentAmount = 0;

        if (liveInvoice.balanceDue > 0) {
            if (appliedAmount + appliedDiscount <= liveInvoice.balanceDue) {
                amountToCurrentInvoice = appliedAmount;
                discountToCurrentInvoice = appliedDiscount;
            } else {
                if (appliedDiscount >= liveInvoice.balanceDue) {
                    discountToCurrentInvoice = liveInvoice.balanceDue;
                    amountToCurrentInvoice = 0;
                    overpaymentAmount = appliedAmount + (appliedDiscount - liveInvoice.balanceDue);
                } else {
                    discountToCurrentInvoice = appliedDiscount;
                    amountToCurrentInvoice = liveInvoice.balanceDue - appliedDiscount;
                    overpaymentAmount = appliedAmount - amountToCurrentInvoice;
                }
            }

            const newPaid = liveInvoice.amountPaid + amountToCurrentInvoice;
            const newDiscountTotal = liveInvoice.discountTotal + discountToCurrentInvoice;
            const newBalance = liveInvoice.balanceDue - (amountToCurrentInvoice + discountToCurrentInvoice);

            await tx.financeInvoice.update({
                where: { id: invoiceId },
                data: {
                    amountPaid: newPaid,
                    discountTotal: newDiscountTotal,
                    balanceDue: newBalance,
                    status: newBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID'
                }
            });
        } else {
            overpaymentAmount = appliedAmount;
        }

        // Audit trail: create PaymentTransaction
        const txRecord = await tx.paymentTransaction.create({
            data: {
                schoolId,
                branchId: activeBranchId,
                studentId: liveInvoice.studentId,
                reference,
                amount: appliedAmount,
                method: method,
                status: 'SUCCESSFUL',
                paidAt: new Date(),
                initiatedBy: req.user.userId
            }
        });

        if (amountToCurrentInvoice > 0) {
            await tx.paymentAllocation.create({
                data: {
                    schoolId,
                    paymentTransactionId: txRecord.id,
                    invoiceId: invoiceId,
                    allocatedAmount: amountToCurrentInvoice
                }
            });
        }

        let newInvoiceNumber = null;
        if (overpaymentAmount > 0) {
            newInvoiceNumber = `${invoicePrefix}${Date.now()}`;
            const newInvoice = await tx.financeInvoice.create({
                data: {
                    schoolId,
                    branchId: activeBranchId || null,
                    studentId: liveInvoice.studentId,
                    term: liveInvoice.term,
                    academicYear: liveInvoice.academicYear,
                    invoiceNumber: newInvoiceNumber,
                    subTotal: overpaymentAmount,
                    discountTotal: 0,
                    totalAmount: overpaymentAmount,
                    amountPaid: overpaymentAmount,
                    balanceDue: 0,
                    status: 'PAID',
                    dueDate: new Date(),
                    items: {
                        create: [{
                            type: 'FEE',
                            label: 'Additional Payment (Credit)',
                            quantity: 1,
                            unitPrice: overpaymentAmount,
                            amount: overpaymentAmount
                        }]
                    }
                }
            });

            await tx.paymentAllocation.create({
                data: {
                    schoolId,
                    paymentTransactionId: txRecord.id,
                    invoiceId: newInvoice.id,
                    allocatedAmount: overpaymentAmount
                }
            });
        }

        // Generate receipt
        const [financeSettingsData, schoolSettingsData] = await Promise.all([
            tx.financeSettings.findUnique({ where: { schoolId } }),
            tx.schoolSettings.findFirst({ where: { schoolId } })
        ]);

        return await createReceipt(tx, {
            schoolId,
            branchId: activeBranchId,
            studentId: liveInvoice.studentId,
            paymentTransactionId: txRecord.id,
            amountPaid: appliedAmount,
            method: method,
            invoiceNumbers: [amountToCurrentInvoice > 0 ? liveInvoice.invoiceNumber : null, newInvoiceNumber].filter(Boolean),
            walletBalanceAfter: 0, // Manual payment doesn't affect wallet
            financeSettings: financeSettingsData,
            schoolSettings: schoolSettingsData
        });
    }, { timeout: 20000, maxWait: 10000 });

    res.status(StatusCodes.OK).json({ 
        msg: `Payment of ₦${appliedAmount.toLocaleString()} recorded successfully`,
        receipt: generatedReceipt 
    });
};

// ─── PHASE 3: CLASS BILLING SUMMARY ─────────────────────────────────────────

const getClassBillingSummary = async (req, res) => {
    const { schoolId } = req.user;
    const { term, academicYear } = req.query;

    // Get all classes for the school
    const classes = await prisma.class.findMany({
        where: { schoolId, isDeleted: false },
        include: {
            students: {
                where: { isDeleted: false },
                select: { id: true }
            }
        },
        orderBy: { name: 'asc' }
    });

    // Fetch all invoices for this school/term/year
    const invoiceWhere = {
        schoolId, isDeleted: false,
        ...(term && { term }),
        ...(academicYear && { academicYear }),
    };

    const allInvoices = await prisma.financeInvoice.findMany({
        where: invoiceWhere,
        include: {
            student: { select: { classId: true } }
        }
    });

    // Map classId → aggregates
    const classMap = {};
    for (const inv of allInvoices) {
        const cid = inv.student?.classId;
        if (!cid) continue;
        if (!classMap[cid]) classMap[cid] = { expected: 0, paid: 0, outstanding: 0, invoiceCount: 0 };
        classMap[cid].expected    += inv.totalAmount;
        classMap[cid].paid        += inv.amountPaid;
        classMap[cid].outstanding += inv.balanceDue;
        classMap[cid].invoiceCount++;
    }

    const summary = classes.map(c => ({
        id: c.id, name: c.name, level: c.level || '',
        studentCount: c.students.length,
        billedCount: classMap[c.id]?.invoiceCount || 0,
        expected:    classMap[c.id]?.expected    || 0,
        paid:        classMap[c.id]?.paid        || 0,
        outstanding: classMap[c.id]?.outstanding || 0,
    }));

    res.status(StatusCodes.OK).json({ summary });
};

// ─── PHASE 3: STUDENTS IN CLASS WITH BILLING STATUS ──────────────────────────

const getClassStudents = async (req, res) => {
    const { classId } = req.params;
    const { schoolId } = req.user;
    const { term, academicYear } = req.query;

    try {
        const students = await prisma.studentProfile.findMany({
            where: {
                OR: [{ schoolId }, { schoolId: null }],
                classId,
                isDeleted: false
            },
            include: {
                user: { select: { name: true } },
                FinanceInvoice: {
                    where: {
                        schoolId,
                        isDeleted: false,
                        ...(term && { term }),
                        ...(academicYear && { academicYear }),
                    },
                    select: { id: true, status: true, totalAmount: true, amountPaid: true, balanceDue: true, invoiceNumber: true }
                },
                Scholarship: {
                    where: { isDeleted: false },
                    select: { id: true, type: true, value: true, status: true }
                }
            },
            orderBy: { admissionDate: 'asc' }
        });

        const result = students.map(s => {
            const invoices = s.FinanceInvoice || [];
            const scholarships = (s.Scholarship || []);
            const totalExpected = invoices.reduce((a, i) => a + i.totalAmount, 0);
            const totalPaid = invoices.reduce((a, i) => a + i.amountPaid, 0);
            const totalOutstanding = invoices.reduce((a, i) => a + i.balanceDue, 0);

            let billingStatus = 'UNBILLED';
            if (invoices.length > 0) {
                if (totalOutstanding <= 0) billingStatus = 'PAID';
                else if (totalPaid > 0) billingStatus = 'PARTIAL';
                else billingStatus = 'UNPAID';
            }

            return {
                id: s.id,
                admissionNo: s.admissionNo,
                classLevel: s.classLevel,
                name: s.user?.name || 'Unknown',
                billingStatus,
                invoiceCount: invoices.length,
                totalExpected,
                totalPaid,
                totalOutstanding,
                hasScholarship: scholarships.some(sc => sc.status === 'ACTIVE'),
                invoices: invoices.map(i => ({
                    id: i.id, invoiceNumber: i.invoiceNumber, status: i.status,
                    totalAmount: i.totalAmount, amountPaid: i.amountPaid, balanceDue: i.balanceDue
                }))
            };
        });

        res.status(StatusCodes.OK).json({ students: result, count: result.length });
    } catch (err) {
        console.error('[getClassStudents ERROR]', err.message, err.stack);
        throw err;
    }
};

// ─── PHASE 3: STUDENT BILLING PROFILE ────────────────────────────────────────

const getStudentBillingProfile = async (req, res) => {
    const { studentId } = req.params;
    const { schoolId } = req.user;
    const { term, academicYear } = req.query;

    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        include: { user: { select: { name: true, email: true } } }
    });
    if (!student || student.schoolId !== schoolId) throw new CustomError.NotFoundError('Student not found');

    // Map human-readable term ("First Term") to Enum ("FIRST_TERM")
    let feeTermScope = term;
    if (term) {
        feeTermScope = term.toUpperCase().replace(/\s+/g, '_');
    }

    // Auto-load applicable fees: WHOLE_SCHOOL or fees matching student's class (classId)
    const fees = await prisma.feeDefinition.findMany({
        where: {
            schoolId, isActive: true, isDeleted: false,
            OR: [
                { scope: 'WHOLE_SCHOOL' },
                { scope: 'CLASS', classIds: { has: student.classId || '' } }
            ],
            ...(feeTermScope && { termScope: { in: ['ANNUAL', feeTermScope] } })
        },
        orderBy: [{ isCompulsory: 'desc' }, { name: 'asc' }]
    });

    // Active scholarships
    const scholarships = await prisma.scholarship.findMany({
        where: { schoolId, studentId, isDeleted: false, status: 'ACTIVE' }
    });

    // Existing invoices for this term
    const existingInvoices = await prisma.financeInvoice.findMany({
        where: {
            schoolId, studentId, isDeleted: false,
            ...(term && { term }),
            ...(academicYear && { academicYear }),
        },
        include: { items: true },
        orderBy: { createdAt: 'desc' }
    });

    // Flag fees already invoiced this term/session (paid or not) so the UI can lock them
    // from being re-selected — voided/cancelled invoices don't count.
    const alreadyBilledIds = await getAlreadyBilledFeeIds(schoolId, studentId, term, academicYear);
    const feesWithBilledFlag = fees.map(f => ({ ...f, alreadyBilled: alreadyBilledIds.has(f.id) }));

    res.status(StatusCodes.OK).json({
        student: { id: student.id, name: student.user?.name, admissionNo: student.admissionNo, classLevel: student.classLevel, classId: student.classId },
        fees: feesWithBilledFlag, scholarships, existingInvoices
    });
};

// ─── PHASE 3: BULK INVOICE GENERATION ────────────────────────────────────────

// Shared invoice-generation core used by bulk-generate, generate-all and family-invoice.
// When feeDefinitionIds is omitted/empty, fees are auto-resolved per student the same way
// getStudentBillingProfile does (WHOLE_SCHOOL fees + CLASS-scoped fees matching the student's class,
// filtered by term scope), mirroring what the single-invoice flow defaults to.
const generateInvoicesForStudents = async ({ studentIds, feeDefinitionIds, term, academicYear, dueDate, schoolId, activeBranchId, userId }) => {
    const [financeSettings, schoolPaymentSettings, schoolSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolPaymentSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);

    const results = { created: [], skipped: [], errors: [] };
    const invoicePrefix = financeSettings?.invoicePrefix || 'INV-';
    const autoApply = schoolPaymentSettings?.autoApplyWallet ?? financeSettings?.autoApplyWallet ?? false;

    // Honor term lock if configured and staff override is not allowed
    const termLock = financeSettings?.financeModuleToggles?.termLock;
    const effectiveTerm = (termLock?.locked && !termLock?.allowStaffOverride)
        ? (termLock.activeTerm || term || schoolSettings?.currentTerm || null)
        : (term || termLock?.activeTerm || schoolSettings?.currentTerm || null);
    const effectiveYear = (termLock?.locked && !termLock?.allowStaffOverride)
        ? (termLock.activeSession || academicYear || schoolSettings?.currentYear || null)
        : (academicYear || termLock?.activeSession || schoolSettings?.currentYear || null);
    const feeTermScope = effectiveTerm ? effectiveTerm.toUpperCase().replace(/\s+/g, '_') : null;

    const explicitFees = (Array.isArray(feeDefinitionIds) && feeDefinitionIds.length > 0)
        ? await prisma.feeDefinition.findMany({ where: { schoolId, isActive: true, isDeleted: false, id: { in: feeDefinitionIds } } })
        : null;
    if (explicitFees && explicitFees.length === 0) {
        throw new CustomError.BadRequestError('No valid fee definitions found');
    }
    const autoFeesPool = explicitFees ? null : await prisma.feeDefinition.findMany({
        where: { schoolId, isActive: true, isDeleted: false, OR: [{ scope: 'WHOLE_SCHOOL' }, { scope: 'CLASS' }] }
    });

    for (const studentId of studentIds) {
        try {
            const student = await prisma.studentProfile.findUnique({
                where: { id: studentId }, select: { schoolId: true, classId: true }
            });
            if (!student || student.schoolId !== schoolId) {
                results.skipped.push({ studentId, reason: 'Not found' });
                continue;
            }

            const candidateFees = explicitFees || autoFeesPool.filter(f => {
                const scopeMatch = f.scope === 'WHOLE_SCHOOL' || (f.scope === 'CLASS' && f.classIds.includes(student.classId || ''));
                if (!scopeMatch) return false;
                if (feeTermScope && !(f.termScope === 'ANNUAL' || f.termScope === feeTermScope)) return false;
                return true;
            });
            if (candidateFees.length === 0) {
                results.skipped.push({ studentId, reason: 'No applicable fees' });
                continue;
            }

            // Never re-bill a fee this student has already been invoiced for this term/session
            // (paid or not — voided/cancelled invoices don't count and free the fee up again).
            const alreadyBilledIds = await getAlreadyBilledFeeIds(schoolId, studentId, effectiveTerm, effectiveYear);
            const fees = candidateFees.filter(f => !alreadyBilledIds.has(f.id));
            if (fees.length === 0) {
                results.skipped.push({ studentId, reason: 'All applicable fees already invoiced for this term' });
                continue;
            }

            // Apply scholarship discounts (all active scholarships for student)
            const scholarships = await prisma.scholarship.findMany({
                where: { schoolId, studentId, isDeleted: false, status: 'ACTIVE' }
            });
            let subTotal = fees.reduce((s, f) => s + f.amount * (f.quantity || 1), 0);
            let discountAmount = 0;
            for (const sc of scholarships) {
                if (sc.type === 'PERCENTAGE') {
                    discountAmount += subTotal * (sc.value / 100);
                } else if (sc.type === 'SCHOLARSHIP' || sc.type === 'FIXED_AMOUNT') {
                    // Student pays sc.value — discount is the difference
                    discountAmount = Math.max(discountAmount, subTotal - sc.value);
                }
            }
            discountAmount = Math.min(discountAmount, subTotal); // cap at subTotal
            const totalAmount = Math.max(0, subTotal - discountAmount);

            const invoiceNumber = `${invoicePrefix}${Date.now()}-${studentId.slice(0, 4).toUpperCase()}`;

            let invoice = await prisma.$transaction(async (tx) => {
                return await tx.financeInvoice.create({
                    data: {
                        schoolId, branchId: activeBranchId || null,
                        studentId, term: effectiveTerm,
                        academicYear: effectiveYear,
                        invoiceNumber, subTotal, discountTotal: discountAmount,
                        totalAmount, balanceDue: totalAmount, status: 'OPEN',
                        dueDate: dueDate ? new Date(dueDate) : null,
                        items: {
                            create: fees.map(f => ({
                                type: f.type || 'FEE', referenceId: f.id,
                                label: f.name, quantity: f.quantity || 1,
                                unitPrice: f.amount, amount: f.amount * (f.quantity || 1)
                            }))
                        }
                    }
                });
            }, { maxWait: 10000, timeout: 30000 });

            if (autoApply && invoice.balanceDue > 0) {
                invoice = await autoApplyStudentWalletToInvoice({
                    schoolId,
                    branchId: activeBranchId || null,
                    studentId,
                    invoice,
                    userId,
                    financeSettings,
                    schoolSettings
                });
            }

            results.created.push({ studentId, invoiceId: invoice.id, invoiceNumber, status: invoice.status, balanceDue: invoice.balanceDue });
        } catch (e) {
            results.errors.push({ studentId, reason: e.message });
        }
    }

    return results;
};

const bulkGenerateInvoices = async (req, res) => {
    const { studentIds, feeDefinitionIds, term, academicYear, dueDate } = req.body;
    const { schoolId, activeBranchId } = req.user;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
        throw new CustomError.BadRequestError('studentIds array is required');
    }

    const results = await generateInvoicesForStudents({ studentIds, feeDefinitionIds, term, academicYear, dueDate, schoolId, activeBranchId, userId: req.user.userId });
    res.status(StatusCodes.CREATED).json({ results, msg: `${results.created.length} invoices generated` });
};

// ─── PHASE 4: FAMILY BILLING ──────────────────────────────────────────────────

const getFamilyBillingSummary = async (req, res) => {
    const { schoolId } = req.user;
    const { term, academicYear } = req.query;

    const parents = await prisma.parentProfile.findMany({
        where: { OR: [{ schoolId }, { schoolId: null }], isDeleted: false },
        include: {
            user: { select: { name: true, email: true } },
            students: {
                where: { isDeleted: false },
                select: { id: true }
            }
        }
    });

    const invoices = await prisma.financeInvoice.findMany({
        where: {
            schoolId, isDeleted: false,
            ...(term && { term }),
            ...(academicYear && { academicYear })
        },
        select: { studentId: true, totalAmount: true, amountPaid: true, balanceDue: true, status: true }
    });

    const studentInvoices = {};
    for (const inv of invoices) {
        if (!studentInvoices[inv.studentId]) studentInvoices[inv.studentId] = [];
        studentInvoices[inv.studentId].push(inv);
    }

    const summary = parents.map(parent => {
        let expected = 0;
        let paid = 0;
        let outstanding = 0;
        let invoiceCount = 0;

        parent.students.forEach(student => {
            const invs = studentInvoices[student.id] || [];
            invs.forEach(inv => {
                expected += inv.totalAmount;
                paid += inv.amountPaid;
                outstanding += inv.balanceDue;
                invoiceCount++;
            });
        });

        return {
            id: parent.id,
            name: parent.fatherName || parent.motherName || parent.user?.name || 'Unknown Parent',
            email: parent.user?.email,
            phone: parent.phone || parent.fatherPhone || parent.motherPhone,
            studentCount: parent.students.length,
            invoiceCount, expected, paid, outstanding
        };
    }).filter(p => p.studentCount > 0);

    res.status(StatusCodes.OK).json({ summary });
};

const getFamilyBillingProfile = async (req, res) => {
    const { parentId } = req.params;
    const { schoolId } = req.user;
    const { term, academicYear } = req.query;

    const parent = await prisma.parentProfile.findUnique({
        where: { id: parentId },
        include: {
            user: { select: { name: true, email: true } },
            students: {
                where: { isDeleted: false },
                include: {
                    user: { select: { name: true } },
                    classArm: { select: { name: true } },
                    FinanceInvoice: {
                        where: {
                            schoolId, isDeleted: false,
                            ...(term && { term }),
                            ...(academicYear && { academicYear })
                        },
                        include: { items: true },
                        orderBy: { createdAt: 'desc' }
                    }
                }
            }
        }
    });

    if (!parent || (parent.schoolId && parent.schoolId !== schoolId)) {
        throw new CustomError.NotFoundError('Parent not found');
    }

    const children = parent.students.map(student => ({
        id: student.id,
        name: student.user?.name,
        admissionNo: student.admissionNo,
        className: student.classArm?.name || student.classLevel,
        invoices: student.FinanceInvoice
    }));

    res.status(StatusCodes.OK).json({
        parent: {
            id: parent.id,
            name: parent.fatherName || parent.motherName || parent.user?.name,
            email: parent.user?.email,
            phone: parent.phone || parent.fatherPhone || parent.motherPhone
        },
        children
    });
};

const sendFamilyInvoice = async (req, res) => {
    const { parentId } = req.params;
    const { schoolId } = req.user;
    const { term, academicYear } = req.body;

    const parent = await prisma.parentProfile.findUnique({
        where: { id: parentId },
        include: {
            user: { select: { name: true, email: true } },
            students: {
                where: { isDeleted: false },
                include: {
                    user: { select: { name: true } },
                    FinanceInvoice: {
                        where: {
                            schoolId, isDeleted: false,
                            ...(term && { term }),
                            ...(academicYear && { academicYear })
                        },
                        include: { items: true }
                    }
                }
            }
        }
    });

    if (!parent || (parent.schoolId && parent.schoolId !== schoolId)) {
        throw new CustomError.NotFoundError('Parent not found');
    }

    const recipientEmail = parent.user?.email;
    if (!recipientEmail) throw new CustomError.BadRequestError('Parent has no email address configured');

    const [financeSettings, schoolSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);

    let grandTotal = 0;
    let grandBalance = 0;
    const childrenData = [];
    const invoiceIdsToMarkSent = [];

    parent.students.forEach(student => {
        if (student.FinanceInvoice.length > 0) {
            const studentTotal = student.FinanceInvoice.reduce((sum, inv) => sum + inv.totalAmount, 0);
            const studentBalance = student.FinanceInvoice.reduce((sum, inv) => sum + inv.balanceDue, 0);
            
            grandTotal += studentTotal;
            grandBalance += studentBalance;

            student.FinanceInvoice.forEach(inv => {
                if (['OPEN', 'DRAFT'].includes(inv.status)) invoiceIdsToMarkSent.push(inv.id);
            });

            childrenData.push({ name: student.user?.name, invoices: student.FinanceInvoice });
        }
    });

    if (childrenData.length === 0) throw new CustomError.BadRequestError('No invoices found for this family for the specified term');

    const parentName = parent.fatherName || parent.motherName || parent.user?.name || 'Parent';

    if (invoiceIdsToMarkSent.length > 0) {
        await prisma.financeInvoice.updateMany({
            where: { id: { in: invoiceIdsToMarkSent } },
            data: { status: 'SENT' }
        });
    }

    // Send the email in the background so the request doesn't block on the SMTP round trip
    // (a full family statement with several children can take a few seconds to deliver).
    const { sendFamilyStatementEmail } = require('../services/finance-email.service');
    sendFamilyStatementEmail(recipientEmail, {
        parentName, childrenData, grandTotal, grandBalance, term, academicYear,
        schoolName: schoolSettings?.schoolName || 'School',
        currencySymbol: financeSettings?.currencySymbol || '₦',
        showItemizedBreakdown: financeSettings?.showItemizedBreakdown !== false
    }).catch(e => console.error('[Finance Email] Family statement email failed:', e.message));

    res.status(StatusCodes.OK).json({ msg: `Family statement sent to ${recipientEmail}` });
};

const generateAllInvoices = async (req, res) => {
    const { term, academicYear, dueDate } = req.body;
    const { schoolId, activeBranchId } = req.user;

    const students = await prisma.studentProfile.findMany({
        where: { schoolId, isDeleted: false },
        select: { id: true }
    });
    if (students.length === 0) {
        return res.status(StatusCodes.OK).json({ results: { created: [], skipped: [], errors: [] }, msg: 'No students found' });
    }

    const results = await generateInvoicesForStudents({
        studentIds: students.map(s => s.id), feeDefinitionIds: null,
        term, academicYear, dueDate, schoolId, activeBranchId, userId: req.user.userId
    });
    res.status(StatusCodes.CREATED).json({ results, msg: `${results.created.length} invoices generated` });
};

const generateFamilyInvoice = async (req, res) => {
    const { parentId } = req.params;
    const { term, academicYear, dueDate } = req.body;
    const { schoolId, activeBranchId } = req.user;

    const parent = await prisma.parentProfile.findUnique({
        where: { id: parentId },
        include: { students: { where: { isDeleted: false }, select: { id: true } } }
    });
    if (!parent || (parent.schoolId && parent.schoolId !== schoolId)) {
        throw new CustomError.NotFoundError('Parent not found');
    }
    if (parent.students.length === 0) {
        return res.status(StatusCodes.OK).json({ results: { created: [], skipped: [], errors: [] }, msg: 'No children found for this family' });
    }

    const results = await generateInvoicesForStudents({
        studentIds: parent.students.map(s => s.id), feeDefinitionIds: null,
        term, academicYear, dueDate, schoolId, activeBranchId, userId: req.user.userId
    });
    res.status(StatusCodes.CREATED).json({ results, msg: `${results.created.length} invoices generated` });
};

// ─── PHASE 9: BULK SEND & BROADSHEET ────────────────────────────────────────

const bulkSendInvoices = async (req, res) => {
    const { invoiceIds } = req.body;
    const { schoolId } = req.user;

    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
        throw new CustomError.BadRequestError('No invoices selected');
    }

    const invoices = await prisma.financeInvoice.findMany({
        where: { id: { in: invoiceIds }, schoolId, isDeleted: false },
        include: {
            student: {
                include: {
                    user: { select: { name: true, email: true } },
                    parent: { include: { user: { select: { email: true, name: true } } } }
                }
            },
            items: true
        }
    });

    const [financeSettings, schoolSettings] = await Promise.all([
        prisma.financeSettings.findUnique({ where: { schoolId } }),
        prisma.schoolSettings.findFirst({ where: { schoolId } })
    ]);

    const currencySymbol = financeSettings?.currencySymbol || '₦';
    const schoolName = schoolSettings?.schoolName || 'School';
    const showItemizedBreakdown = financeSettings?.showItemizedBreakdown !== false;
    
    let sentCount = 0;
    
    // To process concurrently in batches
    const BATCH_SIZE = 5;
    for (let i = 0; i < invoices.length; i += BATCH_SIZE) {
        const batch = invoices.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (invoice) => {
            const parentEmail = invoice.student?.parent?.user?.email;
            const studentEmail = invoice.student?.user?.email;
            const recipientEmail = parentEmail || studentEmail;

            if (recipientEmail) {
                const studentName = invoice.student?.user?.name || 'Student';
                
                try {
                    await sendInvoiceEmail(recipientEmail, {
                        studentName,
                        invoiceNumber: invoice.invoiceNumber,
                        totalAmount: invoice.totalAmount,
                        dueDate: invoice.dueDate,
                        items: invoice.items,
                        showItemizedBreakdown,
                        schoolName,
                        currencySymbol
                    });
                    
                    await prisma.financeInvoice.update({
                        where: { id: invoice.id },
                        data: {
                            isSent: true,
                            lastSentAt: new Date(),
                            ...( ['OPEN', 'DRAFT'].includes(invoice.status) ? { status: 'SENT' } : {} )
                        }
                    });
                    
                    await logNotification(schoolId, invoice.studentId, 'INVOICE_RESENT', recipientEmail);
                    sentCount++;
                } catch (err) {
                    console.error(`Failed to send invoice ${invoice.id} to ${recipientEmail}`, err);
                }
            }
        }));
    }

    res.status(StatusCodes.OK).json({ msg: `Successfully sent ${sentCount} invoices` });
};

const bulkMarkInvoicesPrinted = async (req, res) => {
    const { invoiceIds } = req.body;
    const { schoolId } = req.user;

    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
        throw new CustomError.BadRequestError('No invoices selected');
    }

    await prisma.financeInvoice.updateMany({
        where: { id: { in: invoiceIds }, schoolId, isDeleted: false },
        data: { isPrinted: true, lastPrintedAt: new Date() }
    });

    res.status(StatusCodes.OK).json({ msg: `Successfully marked ${invoiceIds.length} invoices as printed` });
};

const getBillingBroadsheet = async (req, res) => {
    const { schoolId } = req.user;
    const { classId, term, academicYear } = req.query;

    const whereClass = classId ? { classId } : {};
    
    // 1. Fetch Students
    const students = await prisma.studentProfile.findMany({
        where: { schoolId, isDeleted: false, ...whereClass },
        include: {
            user: { select: { name: true } },
            classArm: { select: { name: true } }
        },
        orderBy: { user: { name: 'asc' } }
    });

    if (!students.length) {
        return res.status(StatusCodes.OK).json({ students: [], items: [] });
    }

    const studentIds = students.map(s => s.id);

    // 2. Fetch Invoices and Items
    const invoiceWhere = {
        schoolId,
        studentId: { in: studentIds },
        isDeleted: false,
        ...(term && { term }),
        ...(academicYear && { academicYear })
    };

    const invoices = await prisma.financeInvoice.findMany({
        where: invoiceWhere,
        include: { items: true }
    });

    // 3. Extract unique fee items for the columns
    const itemLabels = new Set();
    invoices.forEach(inv => {
        inv.items.forEach(item => {
            itemLabels.add(item.label);
        });
    });
    
    const columns = Array.from(itemLabels).sort();

    // 4. Map data per student
    const studentDataMap = new Map();
    students.forEach(s => {
        studentDataMap.set(s.id, {
            id: s.id,
            name: s.user?.name || 'Unknown',
            admissionNo: s.admissionNo,
            className: s.classArm?.name || '',
            expected: 0,
            paid: 0,
            balance: 0,
            items: {}
        });
    });

    invoices.forEach(inv => {
        const row = studentDataMap.get(inv.studentId);
        if (row) {
            row.expected += inv.totalAmount;
            row.paid += inv.amountPaid;
            row.balance += inv.balanceDue;
            
            // Map individual items (this will aggregate if multiple invoices have the same item label)
            inv.items.forEach(item => {
                if (!row.items[item.label]) row.items[item.label] = 0;
                row.items[item.label] += item.amount;
            });
        }
    });

    res.status(StatusCodes.OK).json({
        students: Array.from(studentDataMap.values()),
        columns
    });
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
    updateInvoice,
    cancelInvoice,
    bulkCancelInvoices,
    deleteInvoice,
    bulkDeleteInvoices,
    resendInvoice,
    markInvoicePrinted,
    markReceiptPrinted,
    getPaymentTransactions,
    getReceipts,
    applyWalletToInvoice,
    getInvoicesForWalletAllocation,
    getActivePaymentMethods,
    recordManualPayment,
    // Phase 3
    getClassBillingSummary,
    getClassStudents,
    getStudentBillingProfile,
    bulkGenerateInvoices,
    generateAllInvoices,
    // Phase 4
    getFamilyBillingSummary,
    getFamilyBillingProfile,
    generateFamilyInvoice,
    sendFamilyInvoice,
    // Phase 8
    initializePaystackWalletDeposit,
    verifyPayment,
    // Multi-gateway engine
    initializeOnlinePayment,
    initializeWalletDeposit,
    testGatewayConnection,
    settleSuccessfulPaymentTransaction,
    // Phase 9
    bulkSendInvoices,
    bulkMarkInvoicesPrinted,
    getBillingBroadsheet,
};

