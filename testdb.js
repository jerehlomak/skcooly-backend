const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
    const cSession = await prisma.academicSession.findFirst({ where: { isCurrent: true } });
    const cTerm = await prisma.academicTerm.findFirst({ where: { sessionId: cSession?.id, isActive: true } });
    console.log('Current Session:', cSession?.name, 'Current Term:', cTerm?.name);
    
    const classArm = await prisma.class.findFirst({ where: { name: { contains: 'PRIMARY 3 A' } } });
    console.log('Class:', classArm?.id, classArm?.name);
    
    const subject = await prisma.subject.findFirst({ where: { name: { contains: 'Computer Science' } } });
    console.log('Subject:', subject?.id, subject?.name, 'Type:', subject?.type, 'Category:', subject?.categoryId);
    
    const students = await prisma.studentProfile.findMany({ where: { classId: classArm?.id, status: 'Active', isDeleted: false } });
    console.log('Students in class fallback:', students.length);

    // Let's test the filtering
    const subjectCatId = subject?.categoryId;
    const filtered = students.filter(s => !s.subjectCategoryId || s.subjectCategoryId === subjectCatId);
    console.log('Students after category filter:', filtered.length);

    if (subject?.type === 'ELECTIVE') {
        const allocated = await prisma.studentElective.findMany({ where: { subjectId: subject.id } });
        console.log('Allocated Elective:', allocated.length);
    }
}
main().finally(() => prisma.$disconnect());
