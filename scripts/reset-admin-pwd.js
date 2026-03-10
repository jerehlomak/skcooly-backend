require('dotenv').config()
const argon2 = require('argon2')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function main() {
    const email = 'admin@skooly.com'
    const newPassword = 'Admin@1234'

    // Check if admin exists
    const admin = await prisma.centralAdmin.findUnique({
        where: { email }
    })

    if (!admin) {
        console.log(`❌ Admin with email ${email} not found.`)
        // Let's list all admins
        const allAdmins = await prisma.centralAdmin.findMany({ select: { email: true } })
        console.log('Available admins:', allAdmins)
        return
    }

    const hashed = await argon2.hash(newPassword)

    await prisma.centralAdmin.update({
        where: { email },
        data: { password: hashed }
    })

    console.log(`✅ Successfully reset password for ${email} to ${newPassword}`)
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
