const { StatusCodes } = require('http-status-codes');
const prisma = require('../db/prisma');
const CustomError = require('../errors');
const { uploadApplicationDocument } = require('../services/cloudinary-upload.service');
const { sendApplicationApprovedEmail } = require('../services/application-email.service');
const { generateUniquePins } = require('../utils/pinCodeGenerator');

// ─── PUBLIC: Validate PIN for Application ─────────────────────────────────
const validateApplicationPin = async (req, res) => {
    const { pinCode, applicationType, action } = req.body; // action = 'APPLY' | 'CHECK_STATUS'

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
            },
            application: true
        }
    });

    if (!pin) {
        throw new CustomError.BadRequestError('Invalid PIN code.');
    }

    if (pin.pinType !== applicationType) {
        throw new CustomError.BadRequestError(`This PIN is not valid for ${applicationType}. It is a ${pin.pinType} PIN.`);
    }

    if (action === 'APPLY') {
        if (pin.status !== 'ACTIVE' || pin.usageCount >= pin.maxUsage || pin.application) {
            throw new CustomError.BadRequestError('This PIN has already been used to apply. Please choose "Check Status" to view your application.');
        }

        // Fetch the school's dynamic form configuration
        const settings = await prisma.schoolSettings.findFirst({
            where: { schoolId: pin.schoolId },
            select: { admissionFormConfig: true, employmentFormConfig: true }
        });

        res.status(StatusCodes.OK).json({
            message: 'PIN validated successfully for Application.',
            school: pin.school,
            pinId: pin.id,
            formConfig: applicationType === 'ADMISSION_APPLICATION' ? settings?.admissionFormConfig : settings?.employmentFormConfig
        });
    } else if (action === 'CHECK_STATUS') {
        if (!pin.application) {
            throw new CustomError.BadRequestError('No application found for this PIN. Please apply first.');
        }

        const settings = await prisma.schoolSettings.findFirst({
            where: { schoolId: pin.schoolId },
            select: { admissionLetterTemplate: true, employmentLetterTemplate: true }
        });

        res.status(StatusCodes.OK).json({
            message: 'Application found.',
            school: pin.school,
            application: pin.application,
            letterTemplate: applicationType === 'ADMISSION_APPLICATION' ? settings?.admissionLetterTemplate : settings?.employmentLetterTemplate
        });
    } else {
        throw new CustomError.BadRequestError('Invalid action type.');
    }
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
        for (const key of Object.keys(req.files)) {
            const file = req.files[key];
            const up = await uploadApplicationDocument(file, pin.schoolId);
            if (key === 'passport') passportUrl = up.secure_url;
            else if (key === 'birthCertificate') birthCertificateUrl = up.secure_url;
            else if (key === 'otherCertificates') otherCertificatesUrl = up.secure_url;
            else {
                // Dynamic image field!
                formData[key] = up.secure_url;
            }
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

        // Create a notification for the school admin
        await tx.notification.create({
            data: {
                schoolId: pin.schoolId,
                title: `New ${applicationType === 'EMPLOYMENT' ? 'Employment' : 'Admission'} Application`,
                message: `${applicantName} has just submitted an application.`,
                type: 'APPLICATION',
                link: '/dashboard/admission/applications'
            }
        });

        return newApp;
    });

    res.status(StatusCodes.CREATED).json({
        message: 'Application submitted successfully!',
        applicationId: application.id
    });
};

// ─── ADMIN: Submit Application (Bypasses PIN requirement) ─────────────────────
const adminSubmitApplication = async (req, res) => {
    const { applicationType, applicantName, applicantEmail, applicantPhone } = req.body;
    let formData = req.body.formData;

    if (typeof formData === 'string') {
        try {
            formData = JSON.parse(formData);
        } catch (e) {
            formData = {};
        }
    }

    if (!applicationType || !applicantName) {
        throw new CustomError.BadRequestError('Missing required application fields.');
    }

    let passportUrl = null;
    let birthCertificateUrl = null;
    let otherCertificatesUrl = null;

    if (req.files) {
        for (const key of Object.keys(req.files)) {
            const file = req.files[key];
            const up = await uploadApplicationDocument(file, req.user.schoolId);
            if (key === 'passport') passportUrl = up.secure_url;
            else if (key === 'birthCertificate') birthCertificateUrl = up.secure_url;
            else if (key === 'otherCertificates') otherCertificatesUrl = up.secure_url;
            else {
                // Dynamic image field!
                formData[key] = up.secure_url;
            }
        }
    }

    // Auto-generate a unique PIN
    const [newPinCode] = await generateUniquePins(prisma, 1, 12);
    
    // Create the dummy PIN and link it to the application directly
    const application = await prisma.$transaction(async (tx) => {
        // 1. Create the consumed PIN
        const pin = await tx.schoolPin.create({
            data: {
                schoolId: req.user.schoolId,
                batchId: null, // No batch for auto-generated manual pins
                pinCode: newPinCode,
                serialNumber: 'MANUAL-' + Date.now().toString().slice(-6),
                pinType: applicationType,
                maxUsage: 1,
                usageCount: 1,
                status: 'USED',
                purchasedBy: req.user.name,
                createdBy: req.user.userId
            }
        });

        // 2. Log the usage
        await tx.pinUsageLog.create({
            data: {
                pinId: pin.id,
                usageContext: 'MANUAL_APPLICATION_SUBMISSION',
                action: `SUBMITTED_${applicationType}`,
                metadata: { applicantName, adminName: req.user.name }
            }
        });

        // 3. Create the application
        return await tx.application.create({
            data: {
                schoolId: req.user.schoolId,
                pinId: pin.id,
                applicationType,
                applicantName,
                applicantEmail,
                applicantPhone,
                formData,
                passportUrl,
                birthCertificateUrl,
                otherCertificatesUrl,
                status: 'PENDING'
            }
        });
    });

    res.status(StatusCodes.CREATED).json({
        message: 'Manual Application submitted successfully!',
        application,
        generatedPin: newPinCode
    });
};

// ─── DASHBOARD: Get School Applications ───────────────────────────────────
const getSchoolApplications = async (req, res) => {
    const schoolId = req.user.schoolId;
    const { status, type, search, page, limit } = req.query;

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 10;
    const skip = (pageNum - 1) * limitNum;

    const where = { schoolId };
    if (status) where.status = status;
    if (type) where.applicationType = type;
    
    if (search) {
        where.OR = [
            { applicantName: { contains: search, mode: 'insensitive' } },
            { applicantEmail: { contains: search, mode: 'insensitive' } },
            { applicantPhone: { contains: search, mode: 'insensitive' } }
        ];
    }

    const [applications, total] = await Promise.all([
        prisma.application.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                pin: { select: { pinCode: true, serialNumber: true } }
            },
            skip,
            take: limitNum
        }),
        prisma.application.count({ where })
    ]);

    res.status(StatusCodes.OK).json({ 
        applications, 
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum)
    });
};

// ─── DASHBOARD: Update Application Status ─────────────────────────────────
const updateApplicationStatus = async (req, res) => {
    const { id } = req.params;
    const { status, interviewDate, interviewTime, interviewLocation } = req.body;
    const schoolId = req.user.schoolId;

    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
        throw new CustomError.BadRequestError('Invalid status.');
    }

    const application = await prisma.application.update({
        where: { id, schoolId },
        data: { 
            status,
            interviewDate,
            interviewTime,
            interviewLocation
        },
        include: { school: { select: { name: true } } }
    });

    if (status === 'APPROVED' && application.applicantEmail) {
        await sendApplicationApprovedEmail(application.applicantEmail, {
            applicantName: application.applicantName,
            schoolName: application.school.name,
            schoolId: application.schoolId,
            applicationType: application.applicationType,
            interviewDate,
            interviewTime,
            interviewLocation
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
    adminSubmitApplication,
    getSchoolApplications,
    updateApplicationStatus,
    getAllApplications
};
