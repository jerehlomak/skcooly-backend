/**
 * mock-flutterwave.js
 * Simulated Flutterwave API Integration for Fees & Salary
 * 
 * In production, you would replace this with actual axios/fetch calls 
 * to https://api.flutterwave.com/v3 using your FLW_SECRET_KEY.
 */

const crypto = require('crypto');

// Simulate generating a standard Flutterwave payment link for fee collection
const initializePayment = async (amount, email, name, tx_ref) => {
    console.log(`[FLW MOCK] Initializing payment ${tx_ref} for ${name} (${email}): NGN ${amount}`);

    // In reality, this calls flutterwave backend and returns a check-out url
    // For our simulated environment, we immediately return a "success" structure
    return {
        status: "success",
        message: "Hosted Link",
        data: {
            // A fake checkout URL for testing (in reality it's the FW standard checkout)
            link: `https://mock-flutterwave-checkout.test/pay/${tx_ref}`
        }
    };
};

// Simulate querying flutterwave to see if a payment succeeded
const verifyPayment = async (transaction_id) => {
    console.log(`[FLW MOCK] Verifying transaction ID: ${transaction_id}`);

    // A production verification call to flutterwave returns the full tx details
    return {
        status: "success",
        message: "Transaction fetched successfully",
        data: {
            id: transaction_id,
            status: "successful",
            amount: 10000,
            currency: "NGN"
        }
    };
};

// Simulate triggering a Flutterwave Transfer (for teacher salaries)
const initiateTransfer = async (amount, account_bank, account_number, narration) => {
    const transferRef = `FLW-TRF-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    console.log(`[FLW MOCK] Initiating transfer to ${account_bank} / ${account_number}`);
    console.log(`         Amount: NGN ${amount} | Ref: ${transferRef} | Note: ${narration}`);

    return {
        status: "success",
        message: "Transfer Queued Successfully",
        data: {
            id: Math.floor(Math.random() * 1000000),
            account_number,
            bank_code: account_bank,
            amount,
            status: "NEW", // The standard FW initial state
            reference: transferRef
        }
    };
};

module.exports = {
    initializePayment,
    verifyPayment,
    initiateTransfer
};
