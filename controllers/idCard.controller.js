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

module.exports = { generateIDCardPDF };
