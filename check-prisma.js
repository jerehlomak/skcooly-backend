const prisma = require('./db/prisma');

async function test() {
  try {
     console.log('Querying findUnique for school with include plan...');
     const school = await prisma.school.findFirst({
        include: { plan: true, featureFlags: true, group: { select: { id: true, name: true } } }
    });
     console.log('School plan:', school ? school.plan : null);
  } catch(e) {
     console.error('ERROR:', e.message);
  } finally {
     await prisma.$disconnect();
  }
}
test();
