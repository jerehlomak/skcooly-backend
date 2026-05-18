const prisma = require('../db/prisma')

async function main() {
    console.log('Checking parent users and profiles...')
    const parents = await prisma.parentProfile.findMany({
        include: {
            user: true,
            school: true,
            students: {
                include: {
                    user: true
                }
            }
        }
    })

    console.log(`Found ${parents.length} parents:`)
    parents.forEach(p => {
        console.log({
            parentId: p.parentId,
            name: p.user?.name,
            email: p.user?.email,
            role: p.user?.role,
            schoolCode: p.school?.schoolCode,
            students: p.students.map(s => s.user?.name)
        })
    })
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
