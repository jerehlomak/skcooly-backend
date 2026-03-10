const { StatusCodes } = require('http-status-codes')
const argon2 = require('argon2')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const prisma = require('../db/prisma')

// ─── Helper ───────────────────────────────────────────────────────────────────
const createCentralToken = (admin) => {
    return jwt.sign(
        { id: admin.id, email: admin.email, role: admin.role, type: 'central_admin' },
        process.env.CENTRAL_JWT_SECRET || process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_LIFETIME || '1d' }
    )
}

const logAudit = async (adminId, action, entityType, entityId, metadata, ipAddress) => {
    try {
        await prisma.auditLog.create({
            data: { adminId, action, entityType, entityId, metadata, ipAddress },
        })
    } catch (_) { /* non-blocking */ }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

const login = async (req, res) => {
    const { email, password } = req.body
    if (!email || !password) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Email and password are required.' })
    }

    const admin = await prisma.centralAdmin.findUnique({ where: { email } })
    if (!admin || !admin.isActive) {
        return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Invalid credentials.' })
    }

    const isMatch = await argon2.verify(admin.password, password)
    if (!isMatch) {
        return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Invalid credentials.' })
    }

    await prisma.centralAdmin.update({ where: { id: admin.id }, data: { lastLogin: new Date() } })

    const token = createCentralToken(admin)
    res.cookie('centralAdminToken', token, {
        httpOnly: true, signed: true, secure: process.env.NODE_ENV === 'production',
        sameSite: 'none', maxAge: 24 * 60 * 60 * 1000,
    })

    res.status(StatusCodes.OK).json({
        token,
        admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    })
}

const getMe = async (req, res) => {
    const admin = await prisma.centralAdmin.findUnique({
        where: { id: req.centralAdmin.id },
        select: { id: true, name: true, email: true, role: true, lastLogin: true, createdAt: true },
    })
    res.status(StatusCodes.OK).json({ admin })
}

const logout = (req, res) => {
    res.clearCookie('centralAdminToken')
    res.status(StatusCodes.OK).json({ message: 'Logged out.' })
}

const setupFirstAdmin = async (req, res) => {
    const { name, email, password, secret } = req.body
    if (secret !== process.env.ADMIN_SETUP_SECRET) {
        return res.status(StatusCodes.FORBIDDEN).json({ message: 'Invalid setup secret.' })
    }
    const existing = await prisma.centralAdmin.count()
    if (existing > 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Central admin already exists.' })
    }
    const hashed = await argon2.hash(password)
    const admin = await prisma.centralAdmin.create({
        data: { name, email, password: hashed, role: 'SUPER_ADMIN' },
        select: { id: true, name: true, email: true, role: true },
    })
    res.status(StatusCodes.CREATED).json({ admin })
}

// ─── OVERVIEW ─────────────────────────────────────────────────────────────────

const getOverview = async (req, res) => {
    const [totalSchools, activeSchools, suspendedSchools, totalPlans, recentSchools] = await Promise.all([
        prisma.school.count(),
        prisma.school.count({ where: { status: 'ACTIVE' } }),
        prisma.school.count({ where: { status: 'SUSPENDED' } }),
        prisma.subscriptionPlan.count({ where: { isActive: true } }),
        prisma.school.findMany({
            orderBy: { createdAt: 'desc' }, take: 5,
            include: { plan: { select: { name: true, price: true } } },
        }),
    ])

    const studentTotal = await prisma.school.aggregate({ _sum: { studentCount: true } })
    const teacherTotal = await prisma.school.aggregate({ _sum: { teacherCount: true } })

    // Revenue: sum of all active subscriptions' amountPaid
    const revenue = await prisma.schoolSubscription.aggregate({
        _sum: { amountPaid: true },
        where: { isActive: true },
    })

    const openTickets = await prisma.supportTicket.count({ where: { status: 'OPEN' } })

    res.status(StatusCodes.OK).json({
        stats: {
            totalSchools,
            activeSchools,
            suspendedSchools,
            totalStudents: studentTotal._sum.studentCount || 0,
            totalTeachers: teacherTotal._sum.teacherCount || 0,
            totalPlans,
            monthlyRevenue: revenue._sum.amountPaid || 0,
            openTickets,
        },
        recentSchools,
    })
}

// ─── SCHOOL GROUPS ────────────────────────────────────────────────────────────

const getGroups = async (req, res) => {
    const groups = await prisma.schoolGroup.findMany({
        include: {
            schools: { select: { id: true, name: true, studentCount: true } },
            admins: { select: { id: true, name: true, email: true } }
        },
        orderBy: { createdAt: 'desc' }
    })
    res.status(StatusCodes.OK).json({ groups })
}

const createGroup = async (req, res) => {
    const { name, ownerName, ownerEmail } = req.body
    if (!name || !ownerName || !ownerEmail) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Group name, owner name, and owner email are required.' })
    }

    const existingEmail = await prisma.groupAdmin.findUnique({ where: { email: ownerEmail } })
    if (existingEmail) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Group Admin email already exists.' })
    }

    const rawPassword = crypto.randomBytes(6).toString('hex')
    const hashedPassword = await argon2.hash(rawPassword)

    const group = await prisma.schoolGroup.create({
        data: {
            name,
            admins: {
                create: {
                    name: ownerName,
                    email: ownerEmail,
                    password: hashedPassword
                }
            }
        },
        include: { admins: true }
    })

    await logAudit(req.centralAdmin.id, 'CREATE_GROUP', 'SchoolGroup', group.id, { name, ownerEmail }, req.ip)

    const clientBaseUrl = process.env.CLIENT_URL || 'http://localhost:5173'
    res.status(StatusCodes.CREATED).json({
        group,
        credentials: {
            email: ownerEmail,
            password: rawPassword,
            loginUrl: `${clientBaseUrl}/group-admin/login`
        }
    })
}

// ─── SCHOOLS ─────────────────────────────────────────────────────────────────

const getSchools = async (req, res) => {
    const { status, planId, search, page = 1, limit = 20 } = req.query
    const skip = (Number(page) - 1) * Number(limit)

    const where = {}
    if (status) where.status = status
    if (planId) where.planId = planId
    if (search) {
        where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
        ]
    }

    const [schools, total] = await Promise.all([
        prisma.school.findMany({
            where, skip, take: Number(limit),
            orderBy: { createdAt: 'desc' },
            include: {
                plan: { select: { name: true, price: true } },
                subscription: { select: { isActive: true, endDate: true } },
            },
        }),
        prisma.school.count({ where }),
    ])

    res.status(StatusCodes.OK).json({ schools, total, page: Number(page), limit: Number(limit) })
}

const getSchool = async (req, res) => {
    const { id } = req.params
    const school = await prisma.school.findUnique({
        where: { id },
        include: {
            plan: true,
            subscription: true,
            featureFlags: true,
            tickets: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
    })
    if (!school) return res.status(StatusCodes.NOT_FOUND).json({ message: 'School not found.' })
    res.status(StatusCodes.OK).json({ school })
}

const createSchool = async (req, res) => {
    const { name, email, phone, address, country, planId, adminEmail, groupId } = req.body
    if (!name || !email) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Name and email are required.' })
    }

    try {
        // If groupId provided but empty string, treat as null
        const resolvedGroupId = groupId || null

        // Generate a unique, human-readable school code e.g. SKL-A1B2C3
        const generateSchoolCode = () => {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
            let code = 'SKL-'
            for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
            return code
        }
        // Ensure uniqueness
        let schoolCode = generateSchoolCode()
        while (await prisma.school.findUnique({ where: { schoolCode } })) {
            schoolCode = generateSchoolCode()
        }

        const school = await prisma.school.create({
            data: { schoolCode, name, email, phone, address, country, planId: planId || null, adminEmail, groupId: resolvedGroupId, status: 'ACTIVE' },
            include: { plan: { select: { name: true } } },
        })

        // Auto-create subscription if plan is assigned
        if (planId) {
            const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } })
            if (plan) {
                await prisma.schoolSubscription.create({
                    data: { schoolId: school.id, planId, amountPaid: plan.price },
                })
            }
        }

        // ── Auto-provision school admin credentials ───────────────────────────────
        const rawPassword = crypto.randomBytes(6).toString('hex')
        const hashedPassword = await argon2.hash(rawPassword)
        const adminLoginEmail = adminEmail || `admin@${name.toLowerCase().replace(/\s+/g, '')}.skooly.app`

        // Check if that email is already taken, append schoolId suffix if needed
        const exists = await prisma.user.findUnique({ where: { email: adminLoginEmail } })
        const finalEmail = exists ? `${school.id.slice(0, 8)}.${adminLoginEmail}` : adminLoginEmail

        await prisma.user.create({
            data: {
                name: `${name} Admin`,
                email: finalEmail,
                password: hashedPassword,
                role: 'ADMIN',
                schoolId: school.id,
            },
        })

        await logAudit(req.centralAdmin.id, 'CREATE_SCHOOL', 'School', school.id, { name, email }, req.ip)

        res.status(StatusCodes.CREATED).json({
            school,
            credentials: {
                schoolCode: school.schoolCode,
                email: finalEmail,
                password: rawPassword,
                loginUrl: `${process.env.CLIENT_URL || 'http://localhost:5173'}/portal/login`,
            },
        })
    } catch (error) {
        console.error('[createSchool] error:', error)
        if (error.code === 'P2002') {
            return res.status(StatusCodes.BAD_REQUEST).json({ message: 'A school with this email already exists.' })
        }
        if (error.code === 'P2003') {
            return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid plan or group ID provided.' })
        }
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message || 'Failed to create school.' })
    }
}

const updateSchool = async (req, res) => {
    const { id } = req.params
    const { name, email, phone, address, country, planId, adminEmail, studentCount, teacherCount, groupId } = req.body

    try {
        const school = await prisma.school.update({
            where: { id },
            data: {
                name, email, phone, address, country,
                planId: planId || null,
                groupId: groupId || null,
                adminEmail,
                studentCount: studentCount !== undefined ? Number(studentCount) : undefined,
                teacherCount: teacherCount !== undefined ? Number(teacherCount) : undefined,
            },
            include: { plan: { select: { name: true, price: true } } },
        })

        await logAudit(req.centralAdmin.id, 'UPDATE_SCHOOL', 'School', school.id, req.body, req.ip)
        res.status(StatusCodes.OK).json({ school })
    } catch (error) {
        console.error('[updateSchool] error:', error)
        if (error.code === 'P2002') {
            return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Email already in use by another school.' })
        }
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message || 'Failed to update school.' })
    }
}

const suspendSchool = async (req, res) => {
    const { id } = req.params
    const { reason } = req.body

    const school = await prisma.school.update({
        where: { id },
        data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendReason: reason || 'Policy violation' },
    })

    await logAudit(req.centralAdmin.id, 'SUSPEND_SCHOOL', 'School', id, { reason }, req.ip)
    res.status(StatusCodes.OK).json({ school, message: 'School suspended.' })
}

const activateSchool = async (req, res) => {
    const { id } = req.params
    const school = await prisma.school.update({
        where: { id },
        data: { status: 'ACTIVE', suspendedAt: null, suspendReason: null },
    })

    await logAudit(req.centralAdmin.id, 'ACTIVATE_SCHOOL', 'School', id, {}, req.ip)
    res.status(StatusCodes.OK).json({ school, message: 'School activated.' })
}

const deleteSchool = async (req, res) => {
    const { id } = req.params
    await prisma.school.update({ where: { id }, data: { status: 'DELETED' } })
    await logAudit(req.centralAdmin.id, 'DELETE_SCHOOL', 'School', id, {}, req.ip)
    res.status(StatusCodes.OK).json({ message: 'School marked as deleted.' })
}

// Get the school admin credentials (email only — password not stored in plain)
const getSchoolCredentials = async (req, res) => {
    const { id } = req.params
    const adminUser = await prisma.user.findFirst({
        where: { schoolId: id, role: 'ADMIN' },
        select: { id: true, name: true, email: true, createdAt: true },
    })
    if (!adminUser) return res.status(StatusCodes.NOT_FOUND).json({ message: 'No admin user found for this school.' })
    res.status(StatusCodes.OK).json({
        admin: adminUser,
        loginUrl: `${process.env.CLIENT_URL || 'http://localhost:5173'}/login`,
    })
}

// Reset school admin password — generates a new one
const resetSchoolCredentials = async (req, res) => {
    const { id } = req.params
    const adminUser = await prisma.user.findFirst({
        where: { schoolId: id, role: 'ADMIN' },
    })
    if (!adminUser) return res.status(StatusCodes.NOT_FOUND).json({ message: 'No admin user found for this school.' })

    const rawPassword = crypto.randomBytes(6).toString('hex')
    const hashedPassword = await argon2.hash(rawPassword)
    await prisma.user.update({ where: { id: adminUser.id }, data: { password: hashedPassword } })

    await logAudit(req.centralAdmin.id, 'RESET_CREDENTIALS', 'School', id, { adminEmail: adminUser.email }, req.ip)
    res.status(StatusCodes.OK).json({
        credentials: {
            email: adminUser.email,
            password: rawPassword,
            loginUrl: `${process.env.CLIENT_URL || 'http://localhost:5173'}/login`,
        },
    })
}

// Sync school student/teacher counts from real User table
const syncSchoolCounts = async (req, res) => {
    const { id } = req.params
    const [studentCount, teacherCount] = await Promise.all([
        prisma.studentProfile.count({ where: { schoolId: id } }),
        prisma.teacherProfile.count({ where: { schoolId: id } }),
    ])
    const school = await prisma.school.update({
        where: { id },
        data: { studentCount, teacherCount },
    })
    res.status(StatusCodes.OK).json({ school, studentCount, teacherCount })
}

// ─── SUBSCRIPTION PLANS ───────────────────────────────────────────────────────

const getPlans = async (req, res) => {
    const plans = await prisma.subscriptionPlan.findMany({
        orderBy: { price: 'asc' },
        include: { _count: { select: { schools: true } } },
    })
    res.status(StatusCodes.OK).json({ plans })
}

const createPlan = async (req, res) => {
    const { name, description, price, maxStudents, maxTeachers, maxClasses, features, trialDays } = req.body
    const plan = await prisma.subscriptionPlan.create({
        data: { name, description, price, maxStudents, maxTeachers, maxClasses, features: features || [], trialDays: trialDays || 0 },
    })
    await logAudit(req.centralAdmin.id, 'CREATE_PLAN', 'SubscriptionPlan', plan.id, { name }, req.ip)
    res.status(StatusCodes.CREATED).json({ plan })
}

const updatePlan = async (req, res) => {
    const { id } = req.params
    const plan = await prisma.subscriptionPlan.update({
        where: { id },
        data: req.body,
    })
    await logAudit(req.centralAdmin.id, 'UPDATE_PLAN', 'SubscriptionPlan', id, req.body, req.ip)
    res.status(StatusCodes.OK).json({ plan })
}

const deletePlan = async (req, res) => {
    const { id } = req.params
    await prisma.subscriptionPlan.update({ where: { id }, data: { isActive: false } })
    await logAudit(req.centralAdmin.id, 'DELETE_PLAN', 'SubscriptionPlan', id, {}, req.ip)
    res.status(StatusCodes.OK).json({ message: 'Plan deactivated.' })
}

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

const getAnalytics = async (req, res) => {
    const { months = 6 } = req.query
    const monthCount = Number(months)
    const now = new Date()

    const monthlyData = []
    for (let i = monthCount - 1; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
        const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
        const label = start.toLocaleString('en-US', { month: 'short', year: '2-digit' })

        const [newSchools, revenue] = await Promise.all([
            prisma.school.count({ where: { createdAt: { gte: start, lt: end } } }),
            prisma.schoolSubscription.aggregate({
                _sum: { amountPaid: true },
                where: { createdAt: { gte: start, lt: end } },
            }),
        ])

        const studentAndTeacher = await prisma.school.aggregate({
            _sum: { studentCount: true, teacherCount: true },
            where: { createdAt: { lt: end } },
        })

        monthlyData.push({
            month: label,
            newSchools,
            revenue: revenue._sum.amountPaid || 0,
            totalStudents: studentAndTeacher._sum.studentCount || 0,
            totalTeachers: studentAndTeacher._sum.teacherCount || 0,
        })
    }

    const planDistribution = await prisma.subscriptionPlan.findMany({
        include: { _count: { select: { schools: true } } },
        where: { isActive: true },
    })

    res.status(StatusCodes.OK).json({ monthlyData, planDistribution })
}

// ─── FEATURE FLAGS ───────────────────────────────────────────────────────────

const getFeatureFlags = async (req, res) => {
    const { schoolId } = req.params
    const flags = await prisma.featureFlag.findMany({
        where: { schoolId },
        include: { school: { select: { name: true } } },
    })
    res.status(StatusCodes.OK).json({ flags })
}

const upsertFeatureFlag = async (req, res) => {
    const { schoolId } = req.params
    const { feature, enabled } = req.body

    const flag = await prisma.featureFlag.upsert({
        where: { schoolId_feature: { schoolId, feature } },
        update: { enabled },
        create: { schoolId, feature, enabled },
    })

    await logAudit(req.centralAdmin.id, enabled ? 'ENABLE_FEATURE' : 'DISABLE_FEATURE', 'FeatureFlag', schoolId, { feature }, req.ip)
    res.status(StatusCodes.OK).json({ flag })
}

const bulkUpsertFeatureFlags = async (req, res) => {
    const { schoolId } = req.params
    const { flags } = req.body // [{ feature, enabled }]

    const operations = flags.map(({ feature, enabled }) =>
        prisma.featureFlag.upsert({
            where: { schoolId_feature: { schoolId, feature } },
            update: { enabled },
            create: { schoolId, feature, enabled },
        })
    )

    const results = await Promise.all(operations)
    await logAudit(req.centralAdmin.id, 'BULK_FEATURE_UPDATE', 'FeatureFlag', schoolId, { flags }, req.ip)
    res.status(StatusCodes.OK).json({ flags: results })
}

// ─── ANNOUNCEMENTS ───────────────────────────────────────────────────────────

const getAnnouncements = async (req, res) => {
    const { page = 1, limit = 20 } = req.query
    const skip = (Number(page) - 1) * Number(limit)

    const [items, total] = await Promise.all([
        prisma.announcement.findMany({
            orderBy: { createdAt: 'desc' }, skip, take: Number(limit),
            include: { admin: { select: { name: true } } },
        }),
        prisma.announcement.count(),
    ])

    res.status(StatusCodes.OK).json({ announcements: items, total })
}

const createAnnouncement = async (req, res) => {
    const { title, body, type, targetGroup, isPublished } = req.body
    const announcement = await prisma.announcement.create({
        data: {
            title, body, type: type || 'INFO',
            targetGroup: targetGroup || 'ALL',
            isPublished: isPublished || false,
            publishedAt: isPublished ? new Date() : null,
            adminId: req.centralAdmin.id,
        },
    })
    await logAudit(req.centralAdmin.id, 'CREATE_ANNOUNCEMENT', 'Announcement', announcement.id, { title }, req.ip)
    res.status(StatusCodes.CREATED).json({ announcement })
}

const updateAnnouncement = async (req, res) => {
    const { id } = req.params
    const { isPublished } = req.body
    const data = { ...req.body }
    if (isPublished && !data.publishedAt) data.publishedAt = new Date()
    const announcement = await prisma.announcement.update({ where: { id }, data })
    res.status(StatusCodes.OK).json({ announcement })
}

const deleteAnnouncement = async (req, res) => {
    const { id } = req.params
    await prisma.announcement.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ message: 'Announcement deleted.' })
}

// ─── SUPPORT TICKETS ─────────────────────────────────────────────────────────

const getTickets = async (req, res) => {
    const { status, priority, page = 1, limit = 20 } = req.query
    const skip = (Number(page) - 1) * Number(limit)
    const where = {}
    if (status) where.status = status
    if (priority) where.priority = priority

    const [tickets, total] = await Promise.all([
        prisma.supportTicket.findMany({
            where, skip, take: Number(limit), orderBy: { createdAt: 'desc' },
            include: {
                school: { select: { name: true, email: true } },
                replies: {
                    orderBy: { createdAt: 'desc' }, take: 1,
                    include: { admin: { select: { name: true } } },
                },
            },
        }),
        prisma.supportTicket.count({ where }),
    ])

    res.status(StatusCodes.OK).json({ tickets, total })
}

const getTicket = async (req, res) => {
    const { id } = req.params
    const ticket = await prisma.supportTicket.findUnique({
        where: { id },
        include: {
            school: true,
            replies: {
                orderBy: { createdAt: 'asc' },
                include: { admin: { select: { name: true, email: true } } },
            },
        },
    })
    if (!ticket) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Ticket not found.' })
    res.status(StatusCodes.OK).json({ ticket })
}

const replyToTicket = async (req, res) => {
    const { id } = req.params
    const { message, status } = req.body

    const reply = await prisma.ticketReply.create({
        data: { ticketId: id, adminId: req.centralAdmin.id, message },
    })

    if (status) {
        await prisma.supportTicket.update({
            where: { id },
            data: {
                status,
                resolvedAt: status === 'RESOLVED' ? new Date() : undefined,
            },
        })
    }

    await logAudit(req.centralAdmin.id, 'REPLY_TICKET', 'SupportTicket', id, { message: message.slice(0, 50) }, req.ip)
    res.status(StatusCodes.CREATED).json({ reply })
}

const createTicket = async (req, res) => {
    const { schoolId, subject, description, priority, submittedBy } = req.body
    const ticket = await prisma.supportTicket.create({
        data: { schoolId, subject, description, priority: priority || 'MEDIUM', submittedBy },
    })
    res.status(StatusCodes.CREATED).json({ ticket })
}

// ─── AUDIT LOGS ──────────────────────────────────────────────────────────────

const getAuditLogs = async (req, res) => {
    const { adminId, action, entityType, page = 1, limit = 50 } = req.query
    const skip = (Number(page) - 1) * Number(limit)
    const where = {}
    if (adminId) where.adminId = adminId
    if (action) where.action = { contains: action, mode: 'insensitive' }
    if (entityType) where.entityType = entityType

    const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
            where, skip, take: Number(limit), orderBy: { createdAt: 'desc' },
            include: { admin: { select: { name: true, email: true } } },
        }),
        prisma.auditLog.count({ where }),
    ])

    res.status(StatusCodes.OK).json({ logs, total, page: Number(page), limit: Number(limit) })
}

module.exports = {
    login, getMe, logout, setupFirstAdmin,
    getOverview,
    getSchools, getSchool, createSchool, updateSchool, suspendSchool, activateSchool, deleteSchool,
    getSchoolCredentials, resetSchoolCredentials, syncSchoolCounts,
    getPlans, createPlan, updatePlan, deletePlan,
    getAnalytics,
    getFeatureFlags, upsertFeatureFlag, bulkUpsertFeatureFlags,
    getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
    getTickets, getTicket, replyToTicket, createTicket,
    getAuditLogs, getGroups, createGroup
}
