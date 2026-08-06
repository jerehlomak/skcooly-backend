const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');
const { sendTermiiMessage } = require('../services/termii.service');
const { uploadTransferEvidence } = require('../services/cloudinary-upload.service');

// ─── UTILS: Notifications ───
const sendNotification = async (schoolId, title, message, link) => {
    try {
        await prisma.notification.create({
            data: { schoolId, title, message, link, type: 'INFO' }
        });
    } catch (e) {
        console.error('Failed to create notification', e);
    }
};

// ─── ADMIN ENDPOINTS ───

const getMessages = async (req, res) => {
    const { schoolId } = req.user;
    const { invoiceId, search, senderType } = req.query;

    const where = {
        schoolId,
        ...(invoiceId && { invoiceId }),
        ...(senderType && { senderType })
    };

    if (search) {
        where.OR = [
            { subject: { contains: search, mode: 'insensitive' } },
            { body: { contains: search, mode: 'insensitive' } }
        ];
    }

    const messages = await prisma.financeMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
            invoice: { select: { invoiceNumber: true, status: true, totalAmount: true, amountPaid: true, student: { select: { admissionNo: true, user: { select: { name: true } }, parent: { select: { user: { select: { name: true } } } } } } } }
        }
    });

    res.status(StatusCodes.OK).json({ messages });
};

const sendMessage = async (req, res) => {
    const { schoolId, userId } = req.user;
    const { receiverId, invoiceId, subject, body, attachmentUrl, channel = 'sms' } = req.body;

    if (!body) throw new CustomError.BadRequestError('Message body is required');
    if (!receiverId) throw new CustomError.BadRequestError('Receiver ID is required');

    let invoice = null;
    if (invoiceId) {
        invoice = await prisma.financeInvoice.findUnique({ where: { id: invoiceId } });
        if (!invoice || invoice.schoolId !== schoolId) {
            throw new CustomError.NotFoundError('Invoice not found');
        }
    }

    // Replace {PAYMENT_LINK} placeholder with the invoice-specific parent portal URL
    let messageBody = body;
    if (invoiceId && messageBody.includes('{PAYMENT_LINK}')) {
        const paymentLink = `https://skooly.app/parent/fees?invoice=${invoiceId}`;
        messageBody = messageBody.replace(/\{PAYMENT_LINK\}/g, paymentLink);
    }

    const message = await prisma.financeMessage.create({
        data: {
            schoolId,
            senderType: 'ADMIN',
            senderId: userId,
            receiverId,
            invoiceId,
            subject: subject || 'No Subject',
            body: messageBody,
            attachmentUrl
        }
    });

    if (invoiceId) {
        await prisma.financeInvoice.update({
            where: { id: invoiceId },
            data: { lastSentAt: new Date() }
        });
    }

    sendNotification(
        schoolId,
        'Finance Message Sent',
        `A message was sent regarding invoice ${invoice?.invoiceNumber || ''}`,
        '/dashboard/finance/messages'
    );

    // Attempt to dispatch physical Termii SMS
    try {
        const student = await prisma.student.findUnique({
            where: { id: receiverId },
            include: { family: { include: { parent1: true, parent2: true } } }
        });
        
        let parentPhone = null;
        if (student?.family?.parent1?.phone) {
            parentPhone = student.family.parent1.phone;
        } else if (student?.family?.parent2?.phone) {
            parentPhone = student.family.parent2.phone;
        } else if (student?.phone) {
            parentPhone = student.phone;
        }
        
        if (parentPhone) {
            // Clean phone number (strip spaces/symbols)
            parentPhone = parentPhone.replace(/\D/g, '');
            if (parentPhone.startsWith('0')) parentPhone = '234' + parentPhone.slice(1);
            
            // Termii requires string format like '23490126727'
            const termiiChannel = channel === 'whatsapp' ? 'whatsapp' : 'generic';
            await sendTermiiMessage(parentPhone, messageBody, termiiChannel);
        }
    } catch (err) {
        console.error('Failed to dispatch Termii message in sendMessage:', err.message);
    }

    res.status(StatusCodes.CREATED).json({ msg: 'Message sent successfully', message });
};


// Bulk-send a finance message (e.g. a fees reminder) to the parents of a set of students.
// Deduplicates so a parent with multiple selected children only gets one message.
const bulkSendReminders = async (req, res) => {
    const { schoolId, userId } = req.user;
    const { studentIds, subject, body } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
        throw new CustomError.BadRequestError('studentIds array is required');
    }
    if (!body) throw new CustomError.BadRequestError('Message body is required');

    const students = await prisma.studentProfile.findMany({
        where: { id: { in: studentIds }, schoolId },
        include: { parent: { select: { userId: true } } }
    });

    const parentUserIds = [...new Set(students.map(s => s.parent?.userId).filter(Boolean))];
    if (parentUserIds.length === 0) {
        throw new CustomError.BadRequestError('None of the selected students have a linked parent account');
    }

    await prisma.financeMessage.createMany({
        data: parentUserIds.map(receiverId => ({
            schoolId,
            senderType: 'ADMIN',
            senderId: userId,
            receiverId,
            subject: subject || 'Fee Reminder',
            body
        }))
    });

    sendNotification(
        schoolId,
        'Bulk Fee Reminder Sent',
        `A fee reminder was sent to ${parentUserIds.length} parent(s).`,
        '/dashboard/finance/messages'
    );

    res.status(StatusCodes.OK).json({ message: `Reminder sent to ${parentUserIds.length} parent${parentUserIds.length > 1 ? 's' : ''}` });
};

const updateInvoiceDocumentStatus = async (req, res) => {
    const { schoolId } = req.user;
    const { id } = req.params;
    const { action } = req.body; // 'PRINT' or 'SEND'

    const invoice = await prisma.financeInvoice.findFirst({
        where: { id, schoolId }
    });

    if (!invoice) throw new CustomError.NotFoundError('Invoice not found');

    const data = {};
    if (action === 'PRINT') {
        data.isPrinted = true;
        data.lastPrintedAt = new Date();
    } else if (action === 'SEND') {
        data.isSent = true;
        data.lastSentAt = new Date();
    } else {
        throw new CustomError.BadRequestError('Invalid action. Use PRINT or SEND');
    }

    await prisma.financeInvoice.update({
        where: { id },
        data
    });

    res.status(StatusCodes.OK).json({ msg: `Invoice marked as ${action.toLowerCase()}ed` });
};


// ─── PARENT ENDPOINTS ───

const getParentMessages = async (req, res) => {
    const { schoolId, userId } = req.user;
    
    // 1. Fetch parent and their children
    const parent = await prisma.parentProfile.findUnique({
        where: { userId },
        include: { students: true }
    });
    
    // 2. Gather all relevant IDs: the parent's own userId, plus all their students' userIds
    const receiverIds = [userId];
    if (parent && parent.students) {
        parent.students.forEach(student => {
            if (student.userId) receiverIds.push(student.userId);
            if (student.id) receiverIds.push(student.id);
        });
    }
    
    // 3. Fetch messages sent to any of those IDs, or sent BY the parent
    const messages = await prisma.financeMessage.findMany({
        where: {
            schoolId,
            OR: [
                { receiverId: { in: receiverIds } },
                { senderId: userId }
            ]
        },
        orderBy: { createdAt: 'desc' },
        include: {
            invoice: { select: { invoiceNumber: true, status: true, totalAmount: true, amountPaid: true } }
        }
    });

    res.status(StatusCodes.OK).json({ messages });
};

const replyToMessage = async (req, res) => {
    const { schoolId, userId } = req.user;
    let { replyToId, body, attachmentUrl } = req.body;

    // Handle file upload if provided
    if (req.files && req.files.attachment) {
        const result = await uploadTransferEvidence(req.files.attachment, schoolId, userId);
        attachmentUrl = result.secure_url;
    }

    if (!body && !attachmentUrl) {
        throw new CustomError.BadRequestError('Body or attachment is required');
    }
    if (!replyToId) {
        throw new CustomError.BadRequestError('Original message ID is required');
    }

    const originalMessage = await prisma.financeMessage.findUnique({
        where: { id: replyToId }
    });

    if (!originalMessage || originalMessage.schoolId !== schoolId) {
        throw new CustomError.NotFoundError('Message not found');
    }

    const message = await prisma.financeMessage.create({
        data: {
            schoolId,
            senderType: 'PARENT',
            senderId: userId,
            receiverId: originalMessage.senderId, // sends back to admin who initiated
            replyToId: originalMessage.id,
            invoiceId: originalMessage.invoiceId,
            subject: `Re: ${originalMessage.subject || 'Finance Message'}`,
            body: body || 'Attached proof of payment',
            attachmentUrl
        }
    });

    // Notify Admins on dashboard (Pulse)
    await sendNotification(schoolId, 'New Finance Message', `A parent replied with a finance message regarding invoice ${originalMessage.invoiceId ? 'attached' : ''}.`, `/dashboard/finance/messages?contactId=${userId}`);

    res.status(StatusCodes.CREATED).json({ msg: 'Reply sent successfully', message });
};


const markParentMessagesRead = async (req, res) => {
    const { schoolId, userId } = req.user;

    // 1. Fetch parent and their children
    const parent = await prisma.parentProfile.findUnique({
        where: { userId },
        include: { students: true }
    });
    
    // 2. Gather all relevant IDs: the parent's own userId, plus all their students' userIds
    const receiverIds = [userId];
    if (parent && parent.students) {
        parent.students.forEach(student => {
            if (student.userId) receiverIds.push(student.userId);
            if (student.id) receiverIds.push(student.id);
        });
    }

    // 3. Update all messages sent to this parent to isRead: true
    await prisma.financeMessage.updateMany({
        where: {
            schoolId,
            receiverId: { in: receiverIds },
            isRead: false
        },
        data: {
            isRead: true
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Messages marked as read' });
};



module.exports = {
    getMessages,
    sendMessage,
    bulkSendReminders,
    updateInvoiceDocumentStatus,
    getParentMessages,
    replyToMessage,
    markParentMessagesRead
};
