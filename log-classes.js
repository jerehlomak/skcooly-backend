const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const classes = await prisma.class.findMany({
        select: {
            id: true,
            name: true,
            level: true,
            section: true,
        },
        orderBy: [
            { section: 'asc' },
            { level: 'asc' },
            { name: 'asc' }
        ]
    });

    console.log("=========================================");
    console.log("         AVAILABLE CLASS IDs             ");
    console.log("=========================================");
    classes.forEach(c => {
        console.log(`Class: ${c.name} (${c.level || ''} ${c.section || ''})`);
        console.log(`ID: ${c.id}`);
        console.log("-----------------------------------------");
    });
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
