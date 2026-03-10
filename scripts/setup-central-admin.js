/**
 * Setup script: Creates the first Central Admin super-user in the database.
 * Run once after `npx prisma db push`:
 *   node scripts/setup-central-admin.js
 */

require('dotenv').config()
const argon2 = require('argon2')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function main() {
    const count = await prisma.centralAdmin.count()
    if (count > 0) {
        console.log('✅ Central admin already exists. Exiting.')
        return
    }

    const hashed = await argon2.hash('Admin@1234')
    const admin = await prisma.centralAdmin.create({
        data: {
            name: 'Platform Admin',
            email: 'admin@skooly.com',
            password: hashed,
            role: 'SUPER_ADMIN',
        },
        select: { id: true, name: true, email: true, role: true },
    })

    // Seed default subscription plans
    await prisma.subscriptionPlan.createMany({
        data: [
            {
                name: 'Basic',
                description: 'Perfect for small schools getting started',
                price: 29,
                maxStudents: 300,
                maxTeachers: 20,
                maxClasses: 15,
                features: ['students', 'teachers', 'classes', 'attendance', 'results'],
                trialDays: 14,
            },
            {
                name: 'Pro',
                description: 'For growing schools with advanced needs',
                price: 79,
                maxStudents: 1000,
                maxTeachers: 60,
                maxClasses: 40,
                features: ['students', 'teachers', 'classes', 'attendance', 'results', 'timetable', 'finance', 'messaging'],
                trialDays: 7,
            },
            {
                name: 'Enterprise',
                description: 'Unlimited power for large institutions',
                price: 199,
                maxStudents: 10000,
                maxTeachers: 500,
                maxClasses: 200,
                features: ['students', 'teachers', 'classes', 'attendance', 'results', 'timetable', 'finance', 'messaging', 'sms', 'analytics'],
                trialDays: 0,
            },
        ],
        skipDuplicates: true,
    })

    console.log('✅ Central Admin created:', admin)
    console.log('✅ Default plans seeded: Basic ($29), Pro ($79), Enterprise ($199)')
    console.log('\n📧 Login: admin@skooly.com')
    console.log('🔑 Password: Admin@1234')
    console.log('\n⚠️  CHANGE THIS PASSWORD IMMEDIATELY IN PRODUCTION.')
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
