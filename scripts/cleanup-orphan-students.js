// Cleanup: delete orphan student records that have no schoolId
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    // Find orphan students (no schoolId)
    const orphans = await prisma.studentProfile.findMany({
        where: { schoolId: null },
        include: { user: { select: { name: true } } }
    })

    if (orphans.length === 0) {
        console.log('No orphan students found.')
        return
    }

    console.log(`Found ${orphans.length} orphan student(s):`)
    orphans.forEach(s => console.log(`  - ${s.user?.name} (${s.admissionNo})`))

    // Delete their user accounts (which cascades to studentProfile)
    const userIds = orphans.map(s => s.userId).filter(Boolean)
    if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } })
        console.log(`\nDeleted ${userIds.length} orphan user(s).`)
    }

    // Also delete any remaining orphan studentProfiles without userId
    const remaining = await prisma.studentProfile.deleteMany({ where: { schoolId: null } })
    if (remaining.count > 0) {
        console.log(`Deleted ${remaining.count} additional orphan profile(s).`)
    }

    console.log('\nCleanup complete.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
