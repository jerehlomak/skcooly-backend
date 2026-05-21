const prisma = require('../db/prisma');

async function test() {
  try {
     console.log('Querying schoolTypes...');
     const types = await prisma.schoolType.findMany();
     console.log('Found types:', types);
  } catch(e) {
     console.error('ERROR:', e.message);
  } finally {
     await prisma.$disconnect();
  }
}
test();
