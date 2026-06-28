require('dotenv').config()
require('express-async-errors')

const prisma = require('./db/prisma');
// const schoolTypeController = require('./controllers/school-type.controller');
const schoolTypeRoutes = require('./routes/school-type.routes');
const { initSmsWorker } = require('./services/sms-worker.service');
const { startBillingCron } = require('./services/billing-cron.service');
const express = require('express')

const app = express()

// rest of the packages
const morgan = require('morgan')
const cookieParser = require('cookie-parser')
const expressFileupload = require('express-fileupload')

const rateLimiter = require('express-rate-limit')
const helmet = require('helmet')
const cors = require('cors')

// routers
const authRouter = require('./routes/auth.route')
const userRouter = require('./routes/user.route')
const studentRouter = require('./routes/student.route')
const teacherRouter = require('./routes/teacher.route')
const bulkImportRouter = require('./routes/bulkImport.route')
const parentRouter = require('./routes/parent.route')
const classRouter = require('./routes/class.route')
const subjectRouter = require('./routes/subject.route')
const schoolSettingsRouter = require('./routes/schoolSettings.route')
const feeParticularRouter = require('./routes/feeParticular.route')
const bankAccountRouter = require('./routes/bankAccount.route')
const dashboardRouter = require('./routes/dashboard.route')
const roleRouter = require('./routes/role.route')
const financialRouter = require('./routes/financial.route')
const messagingRouter = require('./routes/messaging.route')
const attendanceRouter = require('./routes/attendance.route')
const assessmentRouter = require('./routes/assessment.route')
const centralRouter = require('./routes/central.route')
const groupAdminRouter = require('./routes/groupAdmin.route')
const webhookRouter = require('./routes/webhook.route')
const reportTemplateRouter = require('./routes/reportTemplate.route')
const resultRouter = require('./routes/result.route')
const cbtRouter = require('./routes/cbt.route')
const lmsRouter = require('./routes/lms.route')
const feeRouter = require('./routes/fee.route')
const paymentRouter = require('./routes/payment.route')
const branchRouter = require('./routes/branch.route')  // Phase 1
const schoolPinRouter = require('./routes/schoolPin.route') // Phase 4
const walletRouter = require('./routes/wallet.route')       // Phase 6
const schoolMessagingRouter = require('./routes/schoolMessaging.route')
const applicationRouter = require('./routes/application.route') // Phase 7
const financeV2Router = require('./routes/financev2.route') // Phase 1 Base (Finance Unified)
const financePaymentRouter = require('./routes/financePayment.route') // Phase 2: payments, invoices, transfers
const setupRouter = require('./routes/setup.route') // Admin setup endpoint
const scholarshipRouter = require('./routes/scholarship.route') // Phase 2: scholarships & discounts
const payrollRouter = require('./routes/payroll.route') // Payroll Module
const sessionRouter = require('./routes/sessionRoutes')
const subjectCategoryRouter = require('./routes/subjectCategoryRoutes')
const termRouter = require('./routes/term.route')
const studentFinanceRouter = require('./routes/studentFinance.route') // Phase 6 (Student Wallet & Ledger)
const legacyResultRouter = require('./routes/legacy-result.routes')
const transcriptRouter = require('./routes/transcript.routes')
const sectionRouter = require('./routes/section.route')


// middleware 
const notFoundMiddleware = require('./middleware/not-found')
const errorHnadlerMiddleware = require('./middleware/error-handler')

app.set('trust proxy', 1)
app.use(
    rateLimiter({
        windowMs: 15 * 60 * 1000,
        max: 500, // increased for development
    })
)
app.use(helmet())
app.use(cors({
    origin: [
        process.env.CLIENT_URL || 'http://localhost:5173',
        'http://localhost:5173', // Ensure local dev always works
        'http://localhost:3000', // Local central admin
        process.env.CENTRAL_ADMIN_URL || 'http://localhost:3000',
        'https://central-admin-skcooly.netlify.app', // Deployed Central Admin (Netlify)
        'https://skooly-central-admin.vercel.app',   // Deployed Central Admin (Vercel)
        'https://skcooly-frontend.vercel.app',       // Deployed Frontend (Vercel - primary)
        'https://skcooly.vercel.app',              // Possible alias
        'https://skcoolyplus.com',
        'https://www.skcoolyplus.com',
        'http://skcoolyplus.com',
        'http://www.skcoolyplus.com',
    ],
    credentials: true,
}))

app.use(morgan('tiny'))

// ─── GAP 1 FIX: Paystack webhook needs the RAW body for HMAC verification ────
// Mount BEFORE express.json() so this route receives Buffer, not parsed object.
// All other routes still use JSON.
const { handlePaystackWebhook } = require('./controllers/financePayment.controller');
app.post(
    '/api/v1/finance-v2/webhook/paystack',
    express.raw({ type: 'application/json' }),
    handlePaystackWebhook
);

app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ limit: '20mb', extended: true }))
app.use(cookieParser(process.env.JWT_SECRET))

app.use(express.static('./public'))

app.use(expressFileupload({
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
    abortOnLimit: true,
    responseOnLimit: 'File size limit exceeded (max 20MB)',
    useTempFiles: false,
}))

app.get('/', (req, res) => {
    res.send('ecommercee')
})

app.get('/api/v1', (req, res) => {
    console.log(req.signedCookies)
    res.send('ecommercee')
})

app.use('/api/v1/auth', authRouter)
app.use('/api/v1/users', userRouter)
app.use('/api/v1/students', studentRouter)
app.use('/api/v1/teachers', teacherRouter)
app.use('/api/v1/parents', parentRouter)
app.use('/api/v1/classes', classRouter)
app.use('/api/v1/subjects', subjectRouter)
app.use('/api/v1/school-settings', schoolSettingsRouter)
app.use('/api/v1/fee-particulars', feeParticularRouter)
app.use('/api/v1/bank-accounts', bankAccountRouter)
app.use('/api/v1/dashboard', dashboardRouter)
app.use('/api/v1/roles', roleRouter)
app.use('/api/v1/finance', financialRouter)
app.use('/api/v1/payments', paymentRouter)
app.use('/api/v1/communicate', messagingRouter)
app.use('/api/v1/school', attendanceRouter)
app.use('/api/v1/assessments', assessmentRouter)
app.use('/api/v1/central', centralRouter)
app.use('/api/v1/group-admin', groupAdminRouter)
app.use('/api/v1/webhooks', webhookRouter)
app.use('/api/v1/notifications', require('./routes/notification.route'))
app.use('/api/v1/report-templates', reportTemplateRouter)
app.use('/api/v1/results', resultRouter)
app.use('/api/v1/cbt', cbtRouter)
app.use('/api/v1/lms', lmsRouter)
app.use('/api/v1/fee', feeRouter)
app.use('/api/v1/applications', applicationRouter) // Phase 4: Public Applications
app.use('/api/v1/transcripts', transcriptRouter);
app.use('/api/v1/school-types', schoolTypeRoutes);
app.use('/api/v1/branches', branchRouter)  // Phase 1: branch management
app.use('/api/v1/pins', schoolPinRouter)   // Phase 4: PIN usage
app.use('/api/v1/wallet', walletRouter)    // Phase 6: school wallet
app.use('/api/v1/messaging', schoolMessagingRouter) // Phase 7: messaging center
app.use('/api/v1/finance-v2', financeV2Router) // Phase 1: base finance unified
app.use('/api/v1/finance-v2', financePaymentRouter) // Phase 2: payments, invoices, transfers, receipts
app.use('/api/v1/setup', setupRouter)               // One-time admin setup (protected by ADMIN_SETUP_SECRET)
app.use('/api/v1/legacy-results', legacyResultRouter)
// Duplicate school-types route registration removed
app.use('/api/v1/scholarships', scholarshipRouter)  // Phase 2: scholarships & discounts
app.use('/api/v1/payroll', payrollRouter)           // Payroll Module
app.use('/api/v1/sessions', sessionRouter)
app.use('/api/v1/subject-categories', subjectCategoryRouter)
app.use('/api/v1/terms', termRouter)
app.use('/api/v1/sections', sectionRouter)
app.use('/api/v1/deadlines', require('./routes/deadline.route'))
app.use('/api/v1/exemptions', require('./routes/exemption.route'))
const recoveryRouter = require('./routes/recovery.route')

app.use('/api/v1/bulk-import', bulkImportRouter) // Phase 3: Excel bulk import
app.use('/api/v1/student-finance', studentFinanceRouter) // Phase 6: Student Wallets
const {
    getMyInvoices, getMyInvoice,
    getBillingProfile, updateBillingProfile
} = require('./controllers/central.controller')
const { authenticateUser, authorizePermissions } = require('./middleware/authentication')
app.use('/api/v1/recovery', authenticateUser, recoveryRouter)

// School-facing invoice inbox (Phase 10)
app.get('/api/v1/my-invoices', authenticateUser,
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'),
    getMyInvoices
)
app.get('/api/v1/my-invoices/:id', authenticateUser,
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'),
    getMyInvoice
)
// School billing profile
app.get('/api/v1/billing-profile', authenticateUser,
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'),
    getBillingProfile
)
app.put('/api/v1/billing-profile', authenticateUser,
    authorizePermissions('ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'),
    updateBillingProfile
)

app.use(notFoundMiddleware)
app.use(errorHnadlerMiddleware)

const PORT = process.env.PORT || 5000

// Global school types seeding removed

const start = async () => {
    try {
        await prisma.$connect()
        console.log('Successfully connected to the PostgreSQL database via Prisma')

        startBillingCron()
        initSmsWorker()
        app.listen(PORT, () => console.log(`Server is listening at port ${PORT}`))
    } catch (error) {
        console.log('Failed to connect to the database:', error)
        process.exit(1)
    }
}

start()

// Graceful shutdown — ensures Prisma releases its connection when nodemon restarts
process.on('SIGINT', async () => {
    await prisma.$disconnect()
    process.exit(0)
})
process.on('SIGTERM', async () => {
    await prisma.$disconnect()
    process.exit(0)
})

// Trigger nodemon restart

// Trigger restart
