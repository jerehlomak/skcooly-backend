const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("=== TESTING LEAD INSERT WITH EMPTY STRINGS ===");
  try {
    const lead = await prisma.schoolLead.create({
      data: {
        schoolName: "Test School",
        contactPerson: "Test Admin",
        phoneNumber: "1234567890",
        emailAddress: "test@school.com",
        stateLga: "" || null,
        preferredPlanId: "" || null,
        notes: "Test notes"
      }
    });
    console.log("✅ Success! Lead created:", lead);
    
    // Clean up
    await prisma.schoolLead.delete({ where: { id: lead.id } });
    console.log("🗑️ Cleaned up test lead.");
  } catch (error) {
    console.error("❌ Failed:", error);
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
