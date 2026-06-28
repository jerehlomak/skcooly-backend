require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function kill() {
  try {
    const res = await prisma.$executeRawUnsafe(`
      SELECT pg_terminate_backend(pid) 
      FROM pg_stat_activity 
      WHERE pid <> pg_backend_pid() 
        AND state = 'idle in transaction';
    `);
    console.log('Killed idle transactions:', res);
    
    const res2 = await prisma.$executeRawUnsafe(`
      SELECT pg_terminate_backend(pid) 
      FROM pg_stat_activity 
      WHERE pid <> pg_backend_pid() 
        AND query ILIKE '%SchoolSettings%';
    `);
    console.log('Killed queries on SchoolSettings:', res2);
  } catch(e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}
kill();
