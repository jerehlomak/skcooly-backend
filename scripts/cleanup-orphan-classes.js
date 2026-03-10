const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
    const orphans = await p.class.findMany({ where: { schoolId: null }, select: { id: true, name: true } })
    console.log('Orphan classes:', orphans.map(c => c.name).join(', ') || 'none')
    const del = await p.class.deleteMany({ where: { schoolId: null } })
    console.log('Deleted:', del.count)
}

main().catch(console.error).finally(() => p.$disconnect())
