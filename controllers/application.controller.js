const { StatusCodes } = require('http-status-codes');
const prisma = require('../db/prisma');
const CustomError = require('../errors');
const { uploadApplicationDocument } = require('../services/cloudinary-upload.service');
const { sendApplicationApprovedEmail } = require('../services/application-email.service');

// ─── PUBLIC: Validate PIN for Application ─────────────────────────────────
const validateApplicationPin = async (req, res) => {
    const { pinCode, applicationType } = req.body;

    if (!pinCode || !applicationType) {
        throw new CustomError.BadRequestError('PIN code and application type are required.');
    }

    if (!['ADMISSION_APPLICATION', 'EMPLOYMENT'].includes(applicationType)) {
        throw new CustomError.BadRequestError('Invalid application type.');
    }

    const pin = await prisma.schoolPin.findUnique({
        where: { pinCode },
        include: {
            school: {
                select: {
                    id: true,
                    name: true,
                    logoUrl: true
                }
            }
        }
    });

    if (!pin) {
        throw new CustomError.BadRequestError('Invalid PIN code.');
    }

    if (pin.pinType !== applicationType) {
        throw new CustomError.BadRequestError(`This PIN is not valid for ${applicationType}. It is a ${pin.pinType} PIN.`);
    }

    if (pin.status !== 'ACTIVE' || pin.usageCount >= pin.maxUsage) {
        throw new CustomError.BadRequestError('This PIN has already been used or expired.');
    }

    // PIN is valid. Return the associated school details so the frontend knows where the application is going.
    res.status(StatusCodes.OK).json({
        message: 'PIN validated successfully.',
        school: pin.school,
        pinId: pin.id
    });
};

// ─── PUBLIC: Submit Application ───────────────────────────────────────────
const submitApplication = async (req, res) => {
    const { pinCode, applicationType, applicantName, applicantEmail, applicantPhone } = req.body;
    let formData = req.body.formData;

    if (typeof formData === 'string') {
        try {
            formData = JSON.parse(formData);
        } catch (e) {
            formData = {};
        }
    }

    if (!pinCode || !applicationType || !applicantName) {
        throw new CustomError.BadRequestError('Missing required application fields.');
    }

    // Wrap in transaction to consume PIN and create application simultaneously
    // However, we should upload files first because transactions should be fast
    const pin = await prisma.schoolPin.findUnique({ where: { pinCode } });
    if (!pin) throw new CustomError.BadRequestError('Invalid PIN code.');
    if (pin.status !== 'ACTIVE' || pin.usageCount >= pin.maxUsage) throw new CustomError.BadRequestError('This PIN has already been used.');
    if (pin.pinType !== applicationType) throw new CustomError.BadRequestError(`Invalid PIN type.`);

    let passportUrl = null;
    let birthCertificateUrl = null;
    let otherCertificatesUrl = null;

    if (req.files) {
        if (req.files.passport) {
            const up = await uploadApplicationDocument(req.files.passport, pin.schoolId);
            passportUrl = up.secure_url;
        }
        if (req.files.birthCertificate) {
            const up = await uploadApplicationDocument(req.files.birthCertificate, pin.schoolId);
            birthCertificateUrl = up.secure_url;
        }
        if (req.files.otherCertificates) {
            const up = await uploadApplicationDocument(req.files.otherCertificates, pin.schoolId);
            otherCertificatesUrl = up.secure_url;
        }
    }

    const application = await prisma.$transaction(async (tx) => {
        // Double check inside tx
        const txPin = await tx.schoolPin.findUnique({ where: { id: pin.id } });
        if (txPin.status !== 'ACTIVE' || txPin.usageCount >= txPin.maxUsage) {
            throw new CustomError.BadRequestError('PIN was consumed by another request.');
        }

        // Consume PIN (for applications, maxUsage is typically 1)
        const newUsageCount = txPin.usageCount + 1;
        const newStatus = newUsageCount >= txPin.maxUsage ? 'USED' : 'ACTIVE';

        await tx.schoolPin.update({
            where: { id: pin.id },
            data: {
                usageCount: newUsageCount,
                status: newStatus
            }
        });

        // Log the usage
        await tx.pinUsageLog.create({
            data: {
                pinId: pin.id,
                usageContext: 'APPLICATION_SUBMISSION',
                action: `SUBMITTED_${applicationType}`,
                metadata: { applicantName, applicantEmail }
            }
        });

        // Create the application record
        const newApp = await tx.application.create({
            data: {
                schoolId: pin.schoolId,
                pinId: pin.id,
                applicationType,
                formData: formData || {},
                applicantName,
                applicantEmail,
                applicantPhone,
                passportUrl,
                birthCertificateUrl,
                otherCertificatesUrl,
                status: 'PENDING'
            }
        });

        return newApp;
    });

    res.status(StatusCodes.CREATED).json({
        message: 'Application submitted successfully!',
        applicationId: application.id
    });
};

// ─── DASHBOARD: Get School Applications ───────────────────────────────────
const getSchoolApplications = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { status, type } = req.query;

    const where = { schoolId };
    if (status) where.status = status;
    if (type) where.applicationType = type;

    const applications = await prisma.application.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
            pin: { select: { pinCode: true, serialNumber: true } }
        }
    });

    res.status(StatusCodes.OK).json({ applications });
};

// ─── DASHBOARD: Update Application Status ─────────────────────────────────
const updateApplicationStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const schoolId = req.user.schoolId;

    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
        throw new CustomError.BadRequestError('Invalid status.');
    }

    const application = await prisma.application.update({
        where: { id, schoolId },
        data: { status },
        include: { school: { select: { name: true } } }
    });

    if (status === 'APPROVED' && application.applicantEmail) {
        await sendApplicationApprovedEmail(application.applicantEmail, {
            applicantName: application.applicantName,
            schoolName: application.school.name,
            applicationType: application.applicationType
        });
    }

    res.status(StatusCodes.OK).json({ application });
};

// ─── CENTRAL ADMIN: Get All Applications (Cross-School) ───────────────────
const getAllApplications = async (req, res) => {
    // Only ADMIN role should access this (Central Admin)
    if (req.user.role !== 'ADMIN') {
        throw new CustomError.UnauthorizedError('Unauthorized to access cross-school data');
    }

    const { status, schoolId } = req.query;

    const where = {};
    if (status && status !== 'ALL') where.status = status;
    if (schoolId) where.schoolId = schoolId;

    const applications = await prisma.application.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
            school: { select: { name: true, id: true } }
        }
    });

    res.status(StatusCodes.OK).json({ applications });
};

module.exports = {
    validateApplicationPin,
    submitApplication,
    getSchoolApplications,
    updateApplicationStatus,
    getAllApplications
};
