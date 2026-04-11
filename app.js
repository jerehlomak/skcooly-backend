require('dotenv').config()
require('express-async-errors')

const prisma = require('./db/prisma');
const { startBillingCron } = require('./services/billing-cron.service');
const { initSmsWorker } = require('./services/sms-worker.service'); 
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
const schoolMessagingRouter = require('./routes/schoolMessaging.route') // Phase 7
const financeV2Router = require('./routes/financev2.route') // Phase 1 Base (Finance Unified)
const financePaymentRouter = require('./routes/financePayment.route') // Phase 2: payments, invoices, transfers
const setupRouter = require('./routes/setup.route') // Admin setup endpoint


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
        process.env.CENTRAL_ADMIN_URL || 'http://localhost:3000',
        'https://central-admin-skcooly.netlify.app', // Deployed Central Admin
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

app.use(express.json())
app.use(cookieParser(process.env.JWT_SECRET))

app.use(express.static('./public'))

app.use(expressFileupload())

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
app.use('/api/v1/report-templates', reportTemplateRouter)
app.use('/api/v1/results', resultRouter)
app.use('/api/v1/cbt', cbtRouter)
app.use('/api/v1/lms', lmsRouter)
app.use('/api/v1/fee', feeRouter)
app.use('/api/v1/branches', branchRouter)  // Phase 1: branch management
app.use('/api/v1/pins', schoolPinRouter)   // Phase 4: PIN usage
app.use('/api/v1/wallet', walletRouter)    // Phase 6: school wallet
app.use('/api/v1/messaging', schoolMessagingRouter) // Phase 7: messaging center
app.use('/api/v1/finance-v2', financeV2Router) // Phase 1: base finance unified
app.use('/api/v1/finance-v2', financePaymentRouter) // Phase 2: payments, invoices, transfers, receipts
app.use('/api/v1/setup', setupRouter)               // One-time admin setup (protected by ADMIN_SETUP_SECRET)

const {
    getMyInvoices, getMyInvoice,
    getBillingProfile, updateBillingProfile
} = require('./controllers/central.controller')
const { authenticateUser, authorizePermissions } = require('./middleware/authentication')

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
