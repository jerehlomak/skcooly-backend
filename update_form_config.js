const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const docsGroup = {
    id: 'documents',
    title: 'Required Documents',
    color: 'slate',
    icon: null,
    fields: [
        { id: 'f_passport', label: 'Passport Photograph', type: 'Image', description: 'Recent passport-sized photograph.', isRequired: true, isVisible: true, isPermanent: false, isCustom: true },
        { id: 'f_birth_cert', label: 'Birth Certificate', type: 'Image', description: 'Scanned copy of birth certificate.', isRequired: true, isVisible: true, isPermanent: false, isCustom: true },
        { id: 'f_other_cert', label: 'Other Certificates', type: 'Image', description: 'Any other supporting documents.', isRequired: false, isVisible: true, isPermanent: false, isCustom: true }
    ]
};

const empDocsGroup = {
    id: 'documents',
    title: 'Required Documents',
    color: 'slate',
    icon: null,
    fields: [
        { id: 'f_passport', label: 'Passport Photograph', type: 'Image', description: 'Recent passport-sized photograph.', isRequired: true, isVisible: true, isPermanent: false, isCustom: true },
        { id: 'f_resume', label: 'Resume / CV', type: 'Image', description: 'Curriculum Vitae (PDF/Doc).', isRequired: true, isVisible: true, isPermanent: false, isCustom: true },
        { id: 'f_other_cert', label: 'Other Certificates', type: 'Image', description: 'Any other supporting documents.', isRequired: false, isVisible: true, isPermanent: false, isCustom: true }
    ]
};

async function main() {
    const settings = await prisma.schoolSettings.findMany();
    for (const s of settings) {
        let admissionConfig = s.admissionFormConfig;
        let employmentConfig = s.employmentFormConfig;
        let updated = false;

        if (Array.isArray(admissionConfig)) {
            if (!admissionConfig.find(g => g.id === 'documents')) {
                admissionConfig.push(docsGroup);
                updated = true;
            }
        }

        if (Array.isArray(employmentConfig)) {
            if (!employmentConfig.find(g => g.id === 'documents')) {
                employmentConfig.push(empDocsGroup);
                updated = true;
            }
        }

        if (updated) {
            await prisma.schoolSettings.update({
                where: { id: s.id },
                data: { admissionFormConfig: admissionConfig, employmentFormConfig: employmentConfig }
            });
            console.log(`Updated form config for school ${s.schoolId}`);
        }
    }
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
