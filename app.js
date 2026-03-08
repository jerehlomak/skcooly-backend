require('dotenv').config()
require('express-async-errors')

const prisma = require('./db/prisma');


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
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
}))

app.use(morgan('tiny'))
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
app.use('/api/v1/communicate', messagingRouter)
app.use('/api/v1/school', attendanceRouter)
app.use('/api/v1/assessments', assessmentRouter)


app.use(notFoundMiddleware)
app.use(errorHnadlerMiddleware)

const PORT = process.env.PORT || 5000

const start = async () => {
    try {
        await prisma.$connect()
        console.log('Successfully connected to the PostgreSQL database via Prisma')
        app.listen(PORT, () => console.log(`Server is listening at port ${PORT}`))
    } catch (error) {
        console.log('Failed to connect to the database:', error)
        process.exit(1)
    }
}

start()