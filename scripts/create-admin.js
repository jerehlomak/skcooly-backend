/**
 * Create (or reset) a Central Admin account.
 *
 * Reads credentials from .env — no prompts, no hardcoded values.
 *
 * Usage:
 *   npm run create-admin          ← uses values from .env
 *   ADMIN_EMAIL=me@x.com npm run create-admin   ← override on the fly
 *
 * Supported .env keys (all optional – defaults shown below):
 *   ADMIN_NAME     = "Platform Admin"
 *   ADMIN_EMAIL    = "admin@skooly.com"
 *   ADMIN_PASSWORD = "Admin@1234"
 *   ADMIN_ROLE     = "SUPER_ADMIN"
 *   ADMIN_FORCE    = "false"   set to "true" to update password if admin already exists
 */

'use strict'

require('dotenv').config()
const argon2 = require('argon2')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

const NAME     = process.env.ADMIN_NAME     || 'Platform Admin'
const EMAIL    = process.env.ADMIN_EMAIL    || 'admin@skooly.com'
const PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@1234'
const ROLE     = process.env.ADMIN_ROLE     || 'SUPER_ADMIN'
const FORCE    = (process.env.ADMIN_FORCE   || 'false').toLowerCase() === 'true'

async function main() {
    console.log('\n🛠  Skooly — Central Admin Setup\n')
    console.log(`   Name  : ${NAME}`)
    console.log(`   Email : ${EMAIL}`)
    console.log(`   Role  : ${ROLE}`)
    console.log(`   Force : ${FORCE}\n`)

    const existing = await prisma.centralAdmin.findUnique({ where: { email: EMAIL } })

    if (existing) {
        if (!FORCE) {
            console.log(`ℹ️  Admin already exists (${EMAIL}).`)
            console.log('   Set ADMIN_FORCE=true in .env (or prefix the command) to reset the password.\n')
            return
        }

        // FORCE=true → just update the password
        const hashed = await argon2.hash(PASSWORD)
        await prisma.centralAdmin.update({
            where: { email: EMAIL },
            data:  { password: hashed, name: NAME, role: ROLE, isActive: true },
        })
        console.log(`✅ Password reset for ${EMAIL}`)
        printCreds()
        return
    }

    // Create fresh admin
    const hashed = await argon2.hash(PASSWORD)
    const admin  = await prisma.centralAdmin.create({
        data: {
            name:     NAME,
            email:    EMAIL,
            password: hashed,
            role:     ROLE,
            isActive: true,
        },
        select: { id: true, name: true, email: true, role: true },
    })

    console.log('✅ Central Admin created:', admin)
    printCreds()
}

function printCreds() {
    console.log('\n──────────────────────────────────────────')
    console.log('  LOGIN DETAILS')
    console.log('──────────────────────────────────────────')
    console.log(`  Email    : ${EMAIL}`)
    console.log(`  Password : ${PASSWORD}`)
    console.log(`  Role     : ${ROLE}`)
    console.log('──────────────────────────────────────────')
    if (PASSWORD === 'Admin@1234') {
        console.log('\n  ⚠️  Default password detected.')
        console.log('     Set ADMIN_PASSWORD in your .env before deploying to production!\n')
    } else {
        console.log('')
    }
}

main()
    .catch((err) => { console.error('❌ Error:', err.message); process.exit(1) })
    .finally(() => prisma.$disconnect())
