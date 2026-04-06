/**
 * Re-seed script after migration reset.
 * Run: node scripts/seed.js
 * 
 * Creates:
 *  - 1 Central Admin (SUPER_ADMIN)
 *  - 1 School with a schoolCode
 *  - 1 School Admin user for that school
 */

const prisma = require('../db/prisma')
const argon2 = require('argon2')

async function main() {
    console.log('\n🌱 Starting seed...\n')

    // ── 1. Central Admin ──────────────────────────────────────────────────
    const existingAdmin = await prisma.centralAdmin.findFirst()
    let centralAdmin

    if (!existingAdmin) {
        const hashed = await argon2.hash('admin123')
        centralAdmin = await prisma.centralAdmin.create({
            data: {
                name: 'Super Admin',
                email: 'admin@skooly.app',
                password: hashed,
                role: 'SUPER_ADMIN',
                isActive: true,
            }
        })
        console.log('✅ Central Admin created')
        console.log('   Email   : admin@skooly.app')
        console.log('   Password: admin123')
    } else {
        centralAdmin = existingAdmin
        console.log('ℹ️  Central Admin already exists:', existingAdmin.email)
    }

    // ── 2. School ──────────────────────────────────────────────────────────
    const SCHOOL_CODE = 'SKL-TEST01'
    let school = await prisma.school.findUnique({ where: { schoolCode: SCHOOL_CODE } })

    if (!school) {
        school = await prisma.school.create({
            data: {
                schoolCode: SCHOOL_CODE,
                name: 'Demo School',
                email: 'demo@school.com',
                phone: '+2348000000000',
                address: '1 Demo Street, Lagos',
                country: 'Nigeria',
                status: 'ACTIVE',
            }
        })
        console.log('\n✅ Demo School created')
        console.log('   School Code:', school.schoolCode)
        console.log('   Name       :', school.name)
    } else {
        console.log('\nℹ️  Demo School already exists:', school.schoolCode)
    }

    // ── 3. School Admin User ──────────────────────────────────────────────
    const ADMIN_EMAIL = 'schooladmin@demo.com'
    let adminUser = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } })

    if (!adminUser) {
        const hashed = await argon2.hash('school123')
        adminUser = await prisma.user.create({
            data: {
                name: 'School Admin',
                email: ADMIN_EMAIL,
                password: hashed,
                role: 'ADMIN',
                schoolId: school.id,
            }
        })
        console.log('\n✅ School Admin user created')
        console.log('   Email       :', ADMIN_EMAIL)
        console.log('   Password    : school123')
        console.log('   School Code :', school.schoolCode)
        console.log('   Role        : ADMIN')
    } else {
        console.log('\nℹ️  School Admin already exists:', ADMIN_EMAIL)
    }

    console.log('\n─────────────────────────────────────────')
    console.log('✅ Seed complete!\n')
    console.log('LOGIN DETAILS:')
    console.log('┌── Central Admin ─────────────────────────')
    console.log('│  URL     : http://localhost:3000')
    console.log('│  Email   : admin@skooly.app')
    console.log('│  Password: admin123')
    console.log('├── School Portal ────────────────────────')
    console.log('│  URL       : http://localhost:5173')
    console.log('│  SchoolCode: SKL-TEST01')
    console.log('│  Email     : schooladmin@demo.com')
    console.log('│  Password  : school123')
    console.log('│  Role      : ADMIN')
    console.log('└──────────────────────────────────────────\n')
}

main().catch(console.error).finally(() => prisma.$disconnect())
