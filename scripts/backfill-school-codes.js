// Backfill schoolCode for all schools that don't have one yet
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const generateSchoolCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = 'SKL-'
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
    return code
}

async function main() {
    const schools = await prisma.school.findMany({ where: { schoolCode: null } })
    console.log(`Found ${schools.length} schools without a schoolCode`)

    for (const school of schools) {
        let schoolCode = generateSchoolCode()
        // Ensure uniqueness
        let existing = await prisma.school.findUnique({ where: { schoolCode } })
        while (existing) {
            schoolCode = generateSchoolCode()
            existing = await prisma.school.findUnique({ where: { schoolCode } })
        }

        await prisma.school.update({ where: { id: school.id }, data: { schoolCode } })
        console.log(`  ✓ ${school.name} → ${schoolCode}`)
    }

    console.log('\nBackfill complete! School codes:')
    const all = await prisma.school.findMany({ select: { name: true, schoolCode: true }, orderBy: { name: 'asc' } })
    all.forEach(s => console.log(`  ${s.schoolCode}  ${s.name}`))
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
