const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');

const prisma = new PrismaClient();

async function seed() {
    try {
        const hashedPassword = await argon2.hash('password123');

        // Create Admin
        const admin = await prisma.user.upsert({
            where: { email: 'admin@eschool.com' },
            update: { password: hashedPassword },
            create: {
                name: 'Admin User',
                email: 'admin@eschool.com',
                password: hashedPassword,
                role: 'ADMIN'
            }
        });
        console.log('Admin seeded:', admin.email);

        // Get a Class
        let classLvl = await prisma.classLevel.findFirst();
        if (!classLvl) {
            classLvl = await prisma.classLevel.create({ data: { name: 'JSS1', code: 'JSS1', capacity: 30 } });
        }
        let classArm = await prisma.classArm.findFirst();
        if (!classArm) {
            classArm = await prisma.classArm.create({ data: { name: 'A', classLevelId: classLvl.id } });
        }

        // Create Student
        const studentUser = await prisma.user.upsert({
            where: { email: 'student@eschool.com' },
            update: { password: hashedPassword },
            create: {
                name: 'Student User',
                email: 'student@eschool.com',
                password: hashedPassword,
                role: 'STUDENT'
            }
        });

        const studentProfile = await prisma.studentProfile.upsert({
            where: { userId: studentUser.id },
            update: { admissionNo: 'STU12345' },
            create: {
                userId: studentUser.id,
                admissionNo: 'STU12345',
                firstName: 'John',
                lastName: 'Doe',
                gender: 'Male',
                classLevelId: classLvl.id,
                classArmId: classArm.id
            }
        });
        console.log('Student seeded:', studentUser.email, 'Auth ID:', studentProfile.admissionNo);

        // Create Parent
        const parentUser = await prisma.user.upsert({
            where: { email: 'parent@eschool.com' },
            update: { password: hashedPassword },
            create: {
                name: 'Parent User',
                email: 'parent@eschool.com',
                password: hashedPassword,
                role: 'PARENT'
            }
        });

        const parentProfile = await prisma.parentProfile.upsert({
            where: { userId: parentUser.id },
            update: { fatherName: 'Mr Doe', parentId: 'PAR12345' },
            create: {
                userId: parentUser.id,
                parentId: 'PAR12345',
                fatherName: 'Mr Doe',
                fatherPhone: '08012345678'
            }
        });

        // Link student to parent
        await prisma.studentProfile.update({
            where: { id: studentProfile.id },
            data: { parentProfileId: parentProfile.id }
        });

        console.log('Parent seeded:', parentUser.email, 'Auth ID:', parentProfile.parentId);

        // Create Teacher
        const teacherUser = await prisma.user.upsert({
            where: { email: 'teacher@eschool.com' },
            update: { password: hashedPassword },
            create: {
                name: 'Teacher User',
                email: 'teacher@eschool.com',
                password: hashedPassword,
                role: 'TEACHER'
            }
        });

        const teacherProfile = await prisma.teacherProfile.upsert({
            where: { userId: teacherUser.id },
            update: { employeeId: 'EMP12345' },
            create: {
                userId: teacherUser.id,
                employeeId: 'EMP12345',
                gender: 'Female'
            }
        });
        console.log('Teacher seeded:', teacherUser.email, 'Auth ID:', teacherProfile.employeeId);

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

seed();
