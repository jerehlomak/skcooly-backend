const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: { email: true, role: true, name: true, schoolId: true }
  });
  console.log('All Users:', users);

  const schools = await prisma.school.findMany({
    select: { id: true, name: true }
  });
  console.log('All Schools:', schools);
}

main().catch(console.error).finally(() => prisma.$disconnect());
