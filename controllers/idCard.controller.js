const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const generateIDCardPDF = async (req, res) => {
    const { userId } = req.params;
    const { userType } = req.query; // 'student' or 'staff'
    const schoolId = req.user.schoolId;

    if (!userType || !['student', 'staff'].includes(userType)) {
        throw new CustomError.BadRequestError('userType must be provided (student or staff)');
    }

    let targetUserId = userId;
    let computedUserType = userType;

    if (userId === 'me') {
        if (req.user.role === 'STUDENT') {
            const profile = await prisma.studentProfile.findFirst({ where: { schoolId, isDeleted: false, user: { id: req.user.userId } } });
            if (!profile) throw new CustomError.NotFoundError('Student profile not found');
            targetUserId = profile.id;
            computedUserType = 'student';
        } else if (req.user.role === 'TEACHER') {
            const profile = await prisma.teacherProfile.findFirst({ where: { schoolId, isDeleted: false, user: { id: req.user.userId } } });
            if (!profile) throw new CustomError.NotFoundError('Teacher profile not found');
            targetUserId = profile.id;
            computedUserType = 'staff';
        } else {
            throw new CustomError.BadRequestError('Generations targeting "me" must be invoked by a Student or Staff member session.');
        }
    }

    let publicId = '';
    let name = '';
    let subtitle = '';

    const activeQr = await prisma.qRCode.findFirst({
        where: { schoolId, userId: targetUserId, userType: computedUserType, isActive: true },
        orderBy: { createdAt: 'desc' }
    });

    if (!activeQr) {
        throw new CustomError.BadRequestError('No active QR Token found for this user. Please generate a QR code first in QR Management.');
    }

    const qrToken = activeQr.qrToken;

    if (computedUserType === 'student') {
        const student = await prisma.studentProfile.findFirst({
            where: { id: targetUserId, schoolId },
            include: { user: true, classArm: true }
        });
        if (!student) throw new CustomError.NotFoundError('Student not found');
        publicId = student.publicId || student.admissionNo;
        name = student.user.name;
        subtitle = student.classArm ? student.classArm.name : student.classLevel;
    } else {
        const staff = await prisma.teacherProfile.findFirst({
            where: { id: targetUserId, schoolId },
            include: { user: true }
        });
        if (!staff) throw new CustomError.NotFoundError('Staff not found');
        publicId = staff.publicId || staff.employeeId;
        name = staff.user.name;
        subtitle = staff.department || 'Staff';
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    const schoolName = school?.name || 'Skooly Central';

    try {
        const qrImageBuffer = await QRCode.toBuffer(qrToken, { width: 180, margin: 1 });

        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
        
        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();

        const cardWidth = 260;
        const cardHeight = 400;
        const startX = (width / 2) - (cardWidth / 2);
        const startY = (height / 2) - (cardHeight / 2) + 100;

        page.drawRectangle({
            x: startX, y: startY, width: cardWidth, height: cardHeight,
            borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 2,
            color: rgb(0.98, 0.98, 0.98)
        });

        page.drawRectangle({
            x: startX, y: startY + cardHeight - 60, width: cardWidth, height: 60,
            color: rgb(0.2, 0.3, 0.8)
        });

        page.drawText(schoolName, {
            x: startX + 15, y: startY + cardHeight - 38,
            size: 16, font, color: rgb(1, 1, 1), maxWidth: cardWidth - 30
        });

        const qrImage = await pdfDoc.embedPng(qrImageBuffer);
        page.drawImage(qrImage, {
            x: startX + (cardWidth / 2) - 80,
            y: startY + 120,
            width: 160, height: 160
        });

        page.drawText(name, {
            x: startX + 20, y: startY + 80, size: 16, font,
            color: rgb(0.1, 0.1, 0.1)
        });

        page.drawText(subtitle, {
            x: startX + 20, y: startY + 60, size: 12, font: fontRegular,
            color: rgb(0.4, 0.4, 0.4)
        });

        page.drawText(publicId, {
            x: startX + 20, y: startY + 40, size: 14, font,
            color: rgb(0.2, 0.3, 0.8)
        });

        page.drawText('Official Identification Document', {
            x: startX + 20, y: startY + 15, size: 8, font: fontRegular,
            color: rgb(0.5, 0.5, 0.5)
        });

        const pdfBytes = await pdfDoc.save();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${publicId}_ID_Card.pdf"`);
        res.status(StatusCodes.OK).end(Buffer.from(pdfBytes));
    } catch (err) {
        console.error('PDF Generation Error:', err);
        throw new CustomError.InternalServerError('Failed to generate PDF ID card');
    }
};

// ─── ID CARD MODULE (data for the card designer / generator / digital card) ───

const jwt = require('jsonwebtoken');

const ensureQrSecret = () => {
    if (!process.env.QR_SECRET) throw new CustomError.InternalServerError('QR_SECRET is missing from configuration');
};

const signQrToken = (schoolId, userType, userId, branchId) =>
    jwt.sign({ userId, userType, schoolId, branchId: branchId || null }, process.env.QR_SECRET, { expiresIn: '1y' });

const loadHolders = async (schoolId, userType, classId) => {
    if (userType === 'student') {
        const rows = await prisma.studentProfile.findMany({
            where: { schoolId, isDeleted: false, status: 'Active', ...(classId && { classId }) },
            include: { user: { select: { name: true } }, classArm: { select: { id: true, name: true } } },
            orderBy: [{ classLevel: 'asc' }, { user: { name: 'asc' } }],
        });
        return rows.map(s => ({
            id: s.id,
            userType: 'student',
            name: s.user.name,
            idNumber: s.publicId || s.admissionNo,
            classId: s.classId,
            className: s.classArm?.name || s.classLevel,
            photo: s.profilePicture || null,
            gender: s.gender,
            bloodGroup: s.bloodGroup,
            dateOfBirth: s.dateOfBirth,
            phone: s.phone,
            address: s.address,
        }));
    }
    const rows = await prisma.teacherProfile.findMany({
        where: { schoolId, isDeleted: false, status: 'Active' },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: 'asc' } },
    });
    return rows.map(t => ({
        id: t.id,
        userType: 'staff',
        name: t.user.name,
        idNumber: t.publicId || t.employeeId,
        classId: null,
        className: t.department || t.staffType || 'Staff',
        photo: t.photoUrl || null,
        gender: t.gender,
        bloodGroup: null,
        dateOfBirth: t.dateOfBirth,
        phone: t.phone,
        address: t.address,
    }));
};

const attachQr = async (schoolId, userType, holders) => {
    const qrs = await prisma.qRCode.findMany({
        where: { schoolId, userType, isActive: true, userId: { in: holders.map(h => h.id) } },
        orderBy: { createdAt: 'asc' },
    });
    const latest = new Map(qrs.map(q => [q.userId, q])); // later rows overwrite earlier → newest wins
    return Promise.all(holders.map(async h => {
        const qr = latest.get(h.id);
        return {
            ...h,
            hasQr: !!qr,
            issuedAt: qr?.createdAt || null,
            qrDataUrl: qr ? await QRCode.toDataURL(qr.qrToken, { errorCorrectionLevel: 'L', margin: 0, width: 240 }) : null,
        };
    }));
};

// GET /id-cards/holders?userType=student|staff&classId=
const getIdCardHolders = async (req, res) => {
    const { userType, classId } = req.query;
    if (!['student', 'staff'].includes(userType)) throw new CustomError.BadRequestError('userType must be student or staff');
    const schoolId = req.user.schoolId;

    const holders = await attachQr(schoolId, userType, await loadHolders(schoolId, userType, classId));
    res.status(StatusCodes.OK).json({ holders, count: holders.length });
};

// POST /id-cards/generate { userType } — binds a QR token to every registered holder that lacks one
const generateIdCards = async (req, res) => {
    const { userType } = req.body;
    if (!['student', 'staff'].includes(userType)) throw new CustomError.BadRequestError('userType must be student or staff');
    ensureQrSecret();
    const schoolId = req.user.schoolId;

    const holders = await loadHolders(schoolId, userType);
    const existing = await prisma.qRCode.findMany({
        where: { schoolId, userType, isActive: true, userId: { in: holders.map(h => h.id) } },
        select: { userId: true },
    });
    const have = new Set(existing.map(q => q.userId));
    const missing = holders.filter(h => !have.has(h.id));

    if (missing.length) {
        await prisma.qRCode.createMany({
            data: missing.map(h => ({
                schoolId, branchId: req.user.branchId || null, userType, userId: h.id,
                qrToken: signQrToken(schoolId, userType, h.id, req.user.branchId),
            })),
        });
    }
    res.status(StatusCodes.OK).json({ msg: `${holders.length} ${userType} ID cards ready`, total: holders.length, created: missing.length });
};

// GET /id-cards/me — the logged-in student/staff member's own (digital) card
const getMyIdCard = async (req, res) => {
    const schoolId = req.user.schoolId;
    let userType, profileId;

    if (req.user.role === 'STUDENT') {
        const p = await prisma.studentProfile.findFirst({ where: { schoolId, isDeleted: false, userId: req.user.userId }, select: { id: true } });
        userType = 'student'; profileId = p?.id;
    } else {
        const p = await prisma.teacherProfile.findFirst({ where: { schoolId, isDeleted: false, userId: req.user.userId }, select: { id: true } });
        userType = 'staff'; profileId = p?.id;
    }
    if (!profileId) throw new CustomError.NotFoundError('No ID card profile found for your account');

    let [holder] = await attachQr(schoolId, userType, (await loadHolders(schoolId, userType)).filter(h => h.id === profileId));
    if (!holder.hasQr) {
        ensureQrSecret();
        await prisma.qRCode.create({
            data: { schoolId, branchId: req.user.branchId || null, userType, userId: profileId, qrToken: signQrToken(schoolId, userType, profileId, req.user.branchId) },
        });
        [holder] = await attachQr(schoolId, userType, [holder]);
    }
    res.status(StatusCodes.OK).json({ holder });
};

module.exports = { generateIDCardPDF, getIdCardHolders, generateIdCards, getMyIdCard };
