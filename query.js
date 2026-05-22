const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const classes = await prisma.class.findMany({
    select: { id: true, name: true, level: true, section: true }
  });
  console.log('Classes:', classes);

  const structures = await prisma.assessmentStructure.findMany({
    select: { category: true, parts: true }
  });
  console.log('Assessment Structures:', structures);
}

main().catch(console.error).finally(() => prisma.$disconnect());
