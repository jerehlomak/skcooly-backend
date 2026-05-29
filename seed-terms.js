const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seed() {
    const school = await prisma.school.findFirst();
    if (!school) return console.log('No school found.');
    const schoolId = school.id;
    const activeTerm = await prisma.academicTerm.findFirst({ where: { schoolId, isActive: true } });
    if (!activeTerm) {
        console.log('No active term found.');
        return;
    }
    const students = await prisma.studentProfile.findMany({ where: { schoolId, isDeleted: false, status: 'Active', classId: { not: null } } });
    let count = 0;
    for(const s of students) {
        await prisma.studentTermEnrollment.upsert({
            where: { studentProfileId_academicTermId: { studentProfileId: s.id, academicTermId: activeTerm.id } },
            update: { classId: s.classId, sessionId: activeTerm.sessionId },
            create: { schoolId, studentProfileId: s.id, academicTermId: activeTerm.id, classId: s.classId, sessionId: activeTerm.sessionId }
        });
        count++;
    }
    console.log('Seeded ' + count + ' students for active term ' + activeTerm.name);
}
seed().catch(console.error).finally(() => prisma.$disconnect());
