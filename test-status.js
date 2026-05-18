const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const students = await prisma.studentProfile.findMany({
    select: {
      id: true,
      status: true,
      user: { select: { name: true } }
    }
  });

  console.log(students.map(s => ({ name: s.user.name, status: s.status })));
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
