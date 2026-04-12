const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    console.log('Fetching students without publicId...');
    const students = await prisma.studentProfile.findMany({ where: { publicId: null } });
    for (let i = 0; i < students.length; i++) {
        const publicId = `STU-${new Date().getFullYear()}-${String(i + 1).padStart(4, '0')}`;
        await prisma.studentProfile.update({
            where: { id: students[i].id },
            data: { publicId }
        });
        console.log(`Assigned ${publicId} to student ${students[i].id}`);
    }

    console.log('Fetching teachers without publicId...');
    const teachers = await prisma.teacherProfile.findMany({ where: { publicId: null } });
    for (let i = 0; i < teachers.length; i++) {
        const publicId = `STF-TCH-${String(i + 1).padStart(3, '0')}`;
        await prisma.teacherProfile.update({
            where: { id: teachers[i].id },
            data: { publicId }
        });
        console.log(`Assigned ${publicId} to teacher ${teachers[i].id}`);
    }

    console.log('Backfill complete!');
    process.exit(0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
