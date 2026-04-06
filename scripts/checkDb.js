const prisma = require('../db/prisma')

async function check() {
    const schools = await prisma.school.count()
    const users = await prisma.user.count()
    const admins = await prisma.centralAdmin.count()
    console.log('Schools:', schools)
    console.log('Users:', users)
    console.log('CentralAdmins:', admins)

    if (schools > 0) {
        const list = await prisma.school.findMany({ select: { id: true, name: true, schoolCode: true, status: true } })
        console.log('\nSchool list:', JSON.stringify(list, null, 2))
    } else {
        console.log('\nDB is EMPTY - migration reset wiped all data')
    }
    await prisma.$disconnect()
}

check().catch(console.error)
