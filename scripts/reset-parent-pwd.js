const prisma = require('../db/prisma')
const argon2 = require('argon2')

async function main() {
    const parentEmail = 'jerry.lomak.p0001@skooly.parent'
    console.log(`Resetting password for parent user: ${parentEmail}`)
    
    const user = await prisma.user.findFirst({
        where: { email: parentEmail }
    })
    
    if (!user) {
        console.error('Parent user not found!')
        return
    }
    
    const hashed = await argon2.hash('parent123')
    await prisma.user.update({
        where: { id: user.id },
        data: { password: hashed }
    })
    console.log('✅ Parent password reset successfully to: parent123')
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
