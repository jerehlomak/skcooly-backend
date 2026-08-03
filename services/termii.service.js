const axios = require('axios');

/**
 * Sends a message via Termii API
 * @param {string} to - The recipient phone number (e.g., 23490126727)
 * @param {string} message - The message body
 * @param {string} channel - 'generic' for SMS, 'whatsapp' for WhatsApp
 */
const sendTermiiMessage = async (to, message, channel = 'generic') => {
    // ==========================================
    // MOCK MODE ENABLED
    // ==========================================
    console.log('\n--------------------------------------------------');
    console.log(`[🟢 MOCK ${channel.toUpperCase()}] Termii API Bypassed for local testing`);
    console.log(`To: ${to}`);
    console.log(`Message: "${message}"`);
    console.log('--------------------------------------------------\n');
    
    // Simulate a slight network delay so the frontend UI spinner shows briefly
    return new Promise(resolve => setTimeout(() => resolve(true), 800));
};

module.exports = {
    sendTermiiMessage
};
