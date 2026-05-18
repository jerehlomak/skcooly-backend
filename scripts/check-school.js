const prisma = require('../db/prisma')

async function main() {
    const schoolCode = '624376'
    console.log(`Checking school status for schoolCode: ${schoolCode}`)
    
    const school = await prisma.school.findUnique({
        where: { schoolCode }
    })
    
    if (!school) {
        console.error('School not found!')
        return
    }
    
    console.log('School Details:', {
        id: school.id,
        name: school.name,
        schoolCode: school.schoolCode,
        status: school.status
    })
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
