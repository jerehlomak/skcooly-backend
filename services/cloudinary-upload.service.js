/**
 * Cloudinary Upload Service for Finance Module
 * Handles evidence file uploads for bank transfer submissions.
 * Uses the cloudinary v2 SDK (already installed).
 */
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Upload a transfer evidence file to Cloudinary.
 * @param {Object} file - The file object from express-fileupload
 * @param {string} schoolId - For folder organisation
 * @returns {Promise<{secure_url: string, public_id: string}>}
 */
async function uploadTransferEvidence(file, schoolId) {
    // Validation
    if (!file) throw new Error('No file provided');
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
        throw new Error('Invalid file type. Only JPEG, PNG, WebP, and PDF are allowed.');
    }
    if (file.size > MAX_SIZE_BYTES) {
        throw new Error('File too large. Maximum size is 5MB.');
    }

    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: `skooly/finance/${schoolId}/transfers`,
                resource_type: 'auto',
                allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
                timeout: 60000,
            },
            (error, result) => {
                if (error) return reject(error);
                resolve({ secure_url: result.secure_url, public_id: result.public_id });
            }
        );

        // Convert buffer to readable stream
        const streamifier = require('streamifier');
        streamifier.createReadStream(file.data).pipe(uploadStream);
    });
}

/**
 * Delete a file from Cloudinary by public_id.
 */
async function deleteFile(publicId) {
    try {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'auto' });
    } catch (err) {
        console.error('[Cloudinary] Delete failed:', err.message);
    }
}

module.exports = { uploadTransferEvidence, deleteFile };
