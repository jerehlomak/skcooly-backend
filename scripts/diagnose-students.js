// Diagnose: list all studentProfiles with their schoolId and school name
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const students = await prisma.studentProfile.findMany({
        include: {
            user: { select: { name: true, email: true } }
        },
        orderBy: { enrollmentDate: 'asc' }
    })

    // Get all schools for cross-referencing
    const schools = await prisma.school.findMany({ select: { id: true, name: true, schoolCode: true } })
    const schoolMap = Object.fromEntries(schools.map(s => [s.id, s]))

    console.log(`\nAll ${students.length} StudentProfile records:\n`)
    students.forEach(s => {
        const school = schoolMap[s.schoolId] || {}
        console.log(`  Student:  ${s.user?.name || '?'} (${s.admissionNo})`)
        console.log(`   schoolId: ${s.schoolId}`)
        console.log(`   School:   ${school.name || 'UNKNOWN'} [${school.schoolCode || '?'}]`)
        console.log()
    })

    console.log('\nAll Schools:')
    schools.forEach(sc => console.log(`  [${sc.schoolCode || 'NO CODE'}] ${sc.name} → id: ${sc.id}`))
}

main().catch(console.error).finally(() => prisma.$disconnect())
