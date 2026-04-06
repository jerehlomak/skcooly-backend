/**
 * Finance Encryption Utility
 * AES-256-CBC symmetric encryption for storing Paystack secrets at rest.
 * Key is derived from FINANCE_ENCRYPTION_KEY env var.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32; // 256 bits

function getKey() {
    const raw = process.env.FINANCE_ENCRYPTION_KEY;
    if (!raw) throw new Error('FINANCE_ENCRYPTION_KEY is not set in environment variables');
    // Derive a deterministic 32-byte key from whatever string is provided
    return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypts a plaintext string.
 * @returns {string} "iv:encryptedHex" 
 */
function encrypt(plaintext) {
    if (!plaintext) return null;
    const key = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an encrypted string from the DB.
 * @param {string} encryptedStr - "iv:encryptedHex"
 * @returns {string} plaintext
 */
function decrypt(encryptedStr) {
    if (!encryptedStr) return null;
    const key = getKey();
    const [ivHex, encryptedHex] = encryptedStr.split(':');
    if (!ivHex || !encryptedHex) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

module.exports = { encrypt, decrypt };
