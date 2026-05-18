const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("=== RESULT RELEASE STATUS ===");
  const releases = await prisma.resultReleaseStatus.findMany();
  console.log(releases);

  console.log("\n=== ALL STUDENTS & THEIR CLASSES ===");
  const students = await prisma.studentProfile.findMany({
    include: {
      classArm: true,
      user: true
    }
  });
  console.log(students.map(s => ({
    id: s.id,
    name: s.user.name,
    classId: s.classId,
    className: s.classArm?.name,
    schoolId: s.schoolId
  })));

  console.log("\n=== STUDENT RESULTS ===");
  const results = await prisma.studentResult.findMany({
    take: 5
  });
  console.log(results);
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
