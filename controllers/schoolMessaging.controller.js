const { StatusCodes } = require('http-status-codes')
const prisma = require('../db/prisma')

// ─── Helper: determine caller identity ───────────────────────────────────────
function getCallerIdentity(req) {
    if (req.centralAdmin) {
        return {
            type: 'ADMIN',
            id: req.centralAdmin.id,
            name: req.centralAdmin.name,
        }
    }
    return {
        type: 'SCHOOL',
        id: req.user.id,
        name: req.user.name,
    }
}

// ─── 1. List conversations ────────────────────────────────────────────────────
const getConversations = async (req, res) => {
    const caller = getCallerIdentity(req)

    const where = caller.type === 'ADMIN'
        ? {}                                     // Central admin sees all
        : { schoolId: req.user.schoolId }        // School sees only their own

    const conversations = await prisma.schoolConversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        include: {
            school: { select: { name: true, schoolCode: true } },
            messages: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { content: true, senderType: true, createdAt: true, readAt: true, senderName: true }
            },
            _count: { select: { messages: true } }
        }
    })

    // Attach unread count per conversation (messages not sent by caller & not read)
    const conversationsWithUnread = await Promise.all(conversations.map(async (conv) => {
        const unreadCount = await prisma.schoolMessage.count({
            where: {
                conversationId: conv.id,
                senderType: { not: caller.type },
                readAt: null
            }
        })
        return { ...conv, unreadCount }
    }))

    res.status(StatusCodes.OK).json({ conversations: conversationsWithUnread })
}

// ─── 2. Get messages in a conversation ───────────────────────────────────────
const getMessages = async (req, res) => {
    const { id: conversationId } = req.params
    const caller = getCallerIdentity(req)

    const conversation = await prisma.schoolConversation.findUnique({
        where: { id: conversationId },
        include: { school: { select: { name: true, schoolCode: true } } }
    })

    if (!conversation) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'Conversation not found.' })
    }

    // School can only see their own
    if (caller.type === 'SCHOOL' && conversation.schoolId !== req.user.schoolId) {
        return res.status(StatusCodes.FORBIDDEN).json({ message: 'Access denied.' })
    }

    const messages = await prisma.schoolMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' }
    })

    // Mark incoming messages as read
    await prisma.schoolMessage.updateMany({
        where: {
            conversationId,
            senderType: { not: caller.type },
            readAt: null
        },
        data: { readAt: new Date() }
    })

    res.status(StatusCodes.OK).json({ conversation, messages })
}

// ─── 3. Start a new conversation ─────────────────────────────────────────────
const startConversation = async (req, res) => {
    const caller = getCallerIdentity(req)
    const { subject, content, schoolId } = req.body

    if (!content || content.trim() === '') {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Message content is required.' })
    }

    // For SCHOOL sender, use their own schoolId
    const targetSchoolId = caller.type === 'SCHOOL' ? req.user.schoolId : schoolId
    if (!targetSchoolId) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'schoolId is required for admin.' })
    }

    const conversation = await prisma.$transaction(async (tx) => {
        const conv = await tx.schoolConversation.create({
            data: {
                schoolId: targetSchoolId,
                subject: subject || 'General Inquiry',
                lastMessageAt: new Date(),
            }
        })

        await tx.schoolMessage.create({
            data: {
                conversationId: conv.id,
                senderType: caller.type,
                senderId: caller.id,
                senderName: caller.name,
                content: content.trim(),
            }
        })

        return conv
    })

    res.status(StatusCodes.CREATED).json({ conversation })
}

// ─── 4. Send a reply ─────────────────────────────────────────────────────────
const sendMessage = async (req, res) => {
    const { id: conversationId } = req.params
    const { content } = req.body
    const caller = getCallerIdentity(req)

    if (!content || content.trim() === '') {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Content is required.' })
    }

    const conversation = await prisma.schoolConversation.findUnique({ where: { id: conversationId } })

    if (!conversation) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'Conversation not found.' })
    }

    // School can only reply to their own conversations
    if (caller.type === 'SCHOOL' && conversation.schoolId !== req.user.schoolId) {
        return res.status(StatusCodes.FORBIDDEN).json({ message: 'Access denied.' })
    }

    if (conversation.isClosed) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'This conversation is closed.' })
    }

    const message = await prisma.$transaction(async (tx) => {
        const msg = await tx.schoolMessage.create({
            data: {
                conversationId,
                senderType: caller.type,
                senderId: caller.id,
                senderName: caller.name,
                content: content.trim(),
            }
        })

        await tx.schoolConversation.update({
            where: { id: conversationId },
            data: { lastMessageAt: new Date() }
        })

        return msg
    })

    res.status(StatusCodes.CREATED).json({ message })
}

// ─── 5. Mark messages as read ────────────────────────────────────────────────
const markAsRead = async (req, res) => {
    const { id: conversationId } = req.params
    const caller = getCallerIdentity(req)

    await prisma.schoolMessage.updateMany({
        where: {
            conversationId,
            senderType: { not: caller.type },
            readAt: null
        },
        data: { readAt: new Date() }
    })

    res.status(StatusCodes.OK).json({ message: 'Marked as read.' })
}

// ─── 6. Close / Reopen conversation (admin only) ────────────────────────────
const toggleConversation = async (req, res) => {
    const { id: conversationId } = req.params

    const conv = await prisma.schoolConversation.findUnique({ where: { id: conversationId } })
    if (!conv) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Conversation not found.' })

    const updated = await prisma.schoolConversation.update({
        where: { id: conversationId },
        data: { isClosed: !conv.isClosed }
    })

    res.status(StatusCodes.OK).json({ conversation: updated })
}

module.exports = {
    getConversations,
    getMessages,
    startConversation,
    sendMessage,
    markAsRead,
    toggleConversation
}
