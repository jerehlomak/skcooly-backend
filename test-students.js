const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const students = await prisma.studentProfile.findMany({
    include: {
      user: true,
      classArm: true,
      parent: {
        include: {
          user: true
        }
      },
      feeInvoices: true
    }
  });

  console.log(students.map(s => ({
    id: s.id,
    name: s.user.name,
    class: s.classArm?.name || s.classLevel,
    parent: s.parent ? (s.parent.fatherName || s.parent.motherName || s.parent.user?.name) : 'None',
    invoicesCount: s.feeInvoices.length,
    invoices: s.feeInvoices.map(i => ({ term: i.term, year: i.year, amount: i.totalAmount, status: i.status }))
  })));
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
