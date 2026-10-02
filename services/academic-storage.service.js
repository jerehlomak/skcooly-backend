const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const prisma = require('../db/prisma');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const MB = 1024 * 1024;
const UPLOAD_TYPES = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/** The school's allowance comes from its subscription plan (central admin → plan.storageLimit, in MB). */
const getLimitBytes = async (schoolId) => {
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { plan: { select: { storageLimit: true } } } });
    return (school?.plan?.storageLimit || 1024) * MB;
};

const getUsedBytes = async (schoolId) => {
    const [docs, questions] = await Promise.all([
        prisma.academicDocument.aggregate({ where: { schoolId, isDeleted: false }, _sum: { sizeBytes: true } }),
        prisma.questionBank.aggregate({ where: { schoolId, isDeleted: false }, _sum: { sizeBytes: true } }), // CBT questions (images/diagrams) share the allowance
    ]);
    return (docs._sum.sizeBytes || 0) + (questions._sum.sizeBytes || 0);
};

const getStorage = async (schoolId) => {
    const [used, limit] = await Promise.all([getUsedBytes(schoolId), getLimitBytes(schoolId)]);
    return { usedBytes: used, limitBytes: limit, percent: limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0 };
};

/** Throws a 413 when adding `extraBytes` would push the school past its plan allowance. */
const assertCapacity = async (schoolId, extraBytes, replacingBytes = 0) => {
    const { usedBytes, limitBytes } = await getStorage(schoolId);
    if (usedBytes - replacingBytes + extraBytes > limitBytes) {
        const left = Math.max(0, limitBytes - usedBytes);
        throw Object.assign(new Error(`Not enough storage. Your school has ${(left / MB).toFixed(1)} MB left of ${(limitBytes / MB).toFixed(0)} MB. Delete some documents or ask your administrator to upgrade the plan.`), { status: 413 });
    }
};

const ensureConfigured = () => {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        throw Object.assign(new Error('File storage is not configured on the server.'), { status: 503 });
    }
};

const uploadFile = (file, schoolId) => {
    ensureConfigured();
    const base = file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 60) || 'document';
    const ext = UPLOAD_TYPES[file.mimetype];
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
            { folder: `skooly/academic/${schoolId}`, resource_type: 'raw', type: 'authenticated', public_id: `${base}_${Date.now()}.${ext}` },
            (err, res) => (err ? reject(Object.assign(new Error('Could not store the file. Try again.'), { status: 502 })) : resolve({ url: res.secure_url, publicId: res.public_id })),
        ).end(file.data);
    });
};

const downloadFile = async (doc) => {
    ensureConfigured();
    const url = cloudinary.url(doc.filePublicId, { resource_type: 'raw', type: 'authenticated', sign_url: true, secure: true });
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(r.data);
};

const deleteFile = (publicId) => (publicId ? cloudinary.uploader.destroy(publicId, { resource_type: 'raw', type: 'authenticated' }).catch(() => {}) : Promise.resolve());

module.exports = { MB, UPLOAD_TYPES, getStorage, assertCapacity, uploadFile, downloadFile, deleteFile };
