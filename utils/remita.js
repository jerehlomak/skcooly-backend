/**
 * mock-remita.js
 * Simulated Remita API Integration for Fees & Salary
 * 
 * In production, you would replace this with actual HTTP requests
 * to Remita using your MERCHANT_ID, API_KEY and SERVICE_TYPE_ID.
 */

const crypto = require('crypto');

// Simulate generating an RRR (Remita Retrieval Reference) for fee collection
const generateRRR = async (amount, payerName, payerEmail, orderId) => {
    const mockRRR = `3${Math.floor(Math.random() * 100000000000).toString().padStart(11, '0')}`;
    console.log(`[REMITA MOCK] Generating RRR for Order ${orderId}: NGN ${amount} (${payerName})`);

    return {
        statuscode: "025",
        status: "Payment Reference generated",
        RRR: mockRRR,
        orderId: orderId
    };
};

// Simulate querying an RRR to check if a student/parent paid it at the bank
const verifyRRR = async (rrr) => {
    console.log(`[REMITA MOCK] Checking status of RRR: ${rrr}`);

    return {
        statuscode: "00", // 00 means successful in Remita
        message: "Approved",
        RRR: rrr,
        amount: 50000,
        paymentDate: new Date().toISOString()
    };
};

// Simulate Remita single payment (for teacher salaries)
const singlePayment = async (amount, debitAccount, creditAccount, bankCode, narration) => {
    const transRef = `REM-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    console.log(`[REMITA MOCK] Single Transfer. Debit: ${debitAccount} -> Credit: ${creditAccount} (${bankCode})`);
    console.log(`            Amount: NGN ${amount} | Ref: ${transRef} | Note: ${narration}`);

    return {
        statuscode: "00",
        message: "Successfully initiated",
        data: {
            transRef,
            amount,
            paymentDate: new Date().toISOString()
        }
    };
};

module.exports = {
    generateRRR,
    verifyRRR,
    singlePayment
};
