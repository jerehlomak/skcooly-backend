const prisma = require('../db/prisma');

async function fixClassNames() {
    console.log('Fetching all classes...');
    const classes = await prisma.class.findMany();
    let updatedCount = 0;

    for (const cls of classes) {
        // Look for pattern like " (3 ARMS)" or " (4 arms)" or " (X Arms)"
        const originalName = cls.name;
        const newName = originalName.replace(/\s*\(\d+\s+ARMS?\)\s*/i, ' ').replace(/\s+/g, ' ').trim();
        
        if (originalName !== newName) {
            await prisma.class.update({
                where: { id: cls.id },
                data: { name: newName }
            });
            console.log(`Updated class ID ${cls.id}: "${originalName}" -> "${newName}"`);
            updatedCount++;
        }
    }

    console.log(`Completed. Updated ${updatedCount} classes.`);
}

fixClassNames()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
