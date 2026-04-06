const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const batches = await prisma.schoolPinBatch.findMany({ include: { school: true } });
  console.log(JSON.stringify(batches, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
