const prisma = require('../db/prisma');

async function migrateData() {
    console.log('Starting migration of ClassLevels to Sections...');
    const classLevels = await prisma.classLevel.findMany({
        where: { isActive: true }
    });

    let migrated = 0;
    for (const level of classLevels) {
        // Create Section if it doesn't exist
        let section = await prisma.section.findFirst({
            where: { name: level.name, schoolId: level.schoolId }
        });

        if (!section) {
            section = await prisma.section.create({
                data: {
                    name: level.name,
                    shortCode: level.category || null,
                    schoolId: level.schoolId
                }
            });
            console.log(`Created Section: ${section.name}`);
        }

        // Link classes that match this level's name to the new section
        const updated = await prisma.class.updateMany({
            where: { level: level.name, schoolId: level.schoolId, sectionId: null },
            data: { sectionId: section.id }
        });
        
        migrated += updated.count;
        console.log(`Linked ${updated.count} classes to Section ${section.name}`);
    }

    console.log(`Migration complete. Total classes updated: ${migrated}`);
}

migrateData()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
