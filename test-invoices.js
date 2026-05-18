const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("=== FEE INVOICES ===");
  const invoices = await prisma.feeInvoice.findMany({
    include: {
      student: {
        include: {
          user: true,
          parent: {
            include: {
              user: true
            }
          }
        }
      }
    }
  });
  console.log(invoices.map(inv => ({
    id: inv.id,
    studentId: inv.studentProfileId,
    studentName: inv.student.user.name,
    parentEmail: inv.student.parent?.user?.email,
    parentUserId: inv.student.parent?.userId,
    parentName: inv.student.parent?.fatherName || inv.student.parent?.motherName,
    term: inv.term,
    year: inv.year,
    total: inv.totalAmount,
    amountPaid: inv.amountPaid,
    status: inv.status
  })));

  console.log("\n=== ALL PARENT PROFILES ===");
  const parents = await prisma.parentProfile.findMany({
    include: {
      user: true,
      students: {
        include: {
          user: true
        }
      }
    }
  });
  console.log(parents.map(p => ({
    id: p.id,
    userId: p.userId,
    email: p.user?.email,
    name: p.fatherName || p.motherName || p.guardianName,
    students: p.students.map(s => s.user.name)
  })));
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
