/**
 * Bulk Import Controller
 * Handles Excel-based bulk registration for Staff and Students.
 */
const XLSX = require('xlsx');
const argon2 = require('argon2');
const { StatusCodes } = require('http-status-codes');
const prisma = require('../db/prisma');
const CustomError = require('../errors');
const crypto = require('crypto');

const generateRandomPassword = () => { return '12345'; };

// ─── DOWNLOAD STAFF TEMPLATE ─────────────────────────────────────────────────
const downloadStaffTemplate = (req, res) => {
    const headers = [
        'firstName', 'lastName', 'email', 'phone',
        'staffType', 'employeeId', 'department', 'gender',
        'dateOfBirth', 'qualification', 'salary', 'address'
    ];
    const example = [
        'Abubakar', 'Musa', 'amusa@school.com', '+2348012345678',
        'TEACHER', '', 'Mathematics', 'Male',
        '1990-05-15', 'B.Ed', '80000', '12 Main Street, Kano'
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    // Column widths
    ws['!cols'] = headers.map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Staff Import');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="staff_import_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
};

// ─── DOWNLOAD STUDENT TEMPLATE ────────────────────────────────────────────────
const downloadStudentTemplate = (req, res) => {
    const headers = [
        'name', 'admissionNo', 'className',
        'dateOfBirth', 'phone', 'religion', 'bloodGroup',
        'address', 'previousSchool', 'orphan'
    ];
    const example = [
        'Fatima Bello', '', 'JSS1 A',
        '2010-03-22', '+2348011223344', 'Islam', 'O+',
        '5 Murtala Way, Lagos', 'ABC Primary School', 'no'
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    ws['!cols'] = headers.map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Student Import');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="student_import_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
};

// ─── BULK IMPORT STAFF ────────────────────────────────────────────────────────
const bulkImportStaff = async (req, res) => {
    if (!req.files || !req.files.file) {
        throw new CustomError.BadRequestError('Please upload an Excel file (.xlsx)');
    }

    const file = req.files.file;
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
        throw new CustomError.BadRequestError('Only Excel files (.xlsx, .xls) are accepted');
    }

    const wb = XLSX.read(file.data, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) throw new CustomError.BadRequestError('Excel file is empty or has no data rows');
    if (rows.length > 200) throw new CustomError.BadRequestError('Maximum 200 rows per import');

    const schoolId = req.user.schoolId;
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { schoolCode: true } });
    const schoolTag = (school?.schoolCode || schoolId.slice(0, 8)).toLowerCase().replace(/[^a-z0-9]/g, '');
    const currentYear = new Date().getFullYear();

    // Get last employee id sequence
    const lastTeacher = await prisma.teacherProfile.findFirst({
        where: { employeeId: { startsWith: `TCH-${currentYear}-` }, schoolId },
        orderBy: { hireDate: 'desc' }
    });
    let sequence = 1;
    if (lastTeacher?.employeeId) {
        const parts = lastTeacher.employeeId.split('-');
        if (parts.length === 3) sequence = parseInt(parts[2]) + 1;
    }

    const created = [];
    const failed = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // Excel row (1-indexed + header)

        try {
            const firstName = String(row.firstName || '').trim();
            const lastName = String(row.lastName || '').trim();
            const email = String(row.email || '').trim().toLowerCase();
            const gender = String(row.gender || 'Male').trim();

            if (!firstName || !lastName || !email || !gender) {
                failed.push({ row: rowNum, reason: 'Missing required fields: firstName, lastName, email, gender' });
                continue;
            }

            // Check for email uniqueness
            const existingUser = await prisma.user.findFirst({ where: { email } });
            if (existingUser) {
                failed.push({ row: rowNum, reason: `Email "${email}" already exists` });
                continue;
            }

            let employeeId = String(row.employeeId || '').trim();
            if (!employeeId) {
                const formattedSeq = sequence.toString().padStart(4, '0');
                employeeId = `TCH-${currentYear}-${formattedSeq}`;
            }
            const publicId = `STF-${crypto.randomUUID().slice(0, 8).toUpperCase()}-${Date.now().toString().slice(-4)}`;
            sequence++;

            const generatedPassword = generateRandomPassword();
            const hashedPassword = await argon2.hash(generatedPassword);

            const newStaff = await prisma.user.create({
                data: {
                    name: `${firstName} ${lastName}`,
                    email,
                    password: hashedPassword,
                    role: (row.staffType === 'ADMIN') ? 'ADMIN' : 'TEACHER',
                    schoolId,
                    teacherProfile: {
                        create: {
                            schoolId,
                            employeeId,
                            publicId,
                            staffType: String(row.staffType || 'TEACHER').trim(),
                            gender,
                            department: String(row.department || '').trim() || null,
                            phone: String(row.phone || '').trim() || null,
                            dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
                            qualification: String(row.qualification || '').trim() || null,
                            salary: row.salary ? parseFloat(String(row.salary)) : null,
                            address: String(row.address || '').trim() || null,
                        }
                    }
                },
                select: { id: true, name: true, email: true }
            });

            created.push({
                name: newStaff.name,
                email: newStaff.email,
                employeeId,
                generatedPassword,
                row: rowNum
            });
        } catch (err) {
            failed.push({ row: rowNum, reason: err.message });
        }
    }

    res.status(StatusCodes.OK).json({
        msg: `Import complete. ${created.length} created, ${failed.length} failed.`,
        created,
        failed,
        summary: { total: rows.length, created: created.length, failed: failed.length }
    });
};

// ─── BULK IMPORT STUDENTS ─────────────────────────────────────────────────────
const bulkImportStudents = async (req, res) => {
    if (!req.files || !req.files.file) {
        throw new CustomError.BadRequestError('Please upload an Excel file (.xlsx)');
    }

    const file = req.files.file;
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
        throw new CustomError.BadRequestError('Only Excel files (.xlsx, .xls) are accepted');
    }

    const wb = XLSX.read(file.data, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) throw new CustomError.BadRequestError('Excel file is empty or has no data rows');
    if (rows.length > 500) throw new CustomError.BadRequestError('Maximum 500 rows per import');

    const schoolId = req.user.schoolId;
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { schoolCode: true } });
    const schoolTag = (school?.schoolCode || schoolId.slice(0, 8)).toLowerCase().replace(/[^a-z0-9]/g, '');
    const currentYear = new Date().getFullYear();

    const lastStudent = await prisma.studentProfile.findFirst({
        where: { admissionNo: { startsWith: `SKL-${currentYear}-` }, schoolId },
        orderBy: { enrollmentDate: 'desc' }
    });
    let sequence = 1;
    if (lastStudent?.admissionNo?.includes('-')) {
        const parts = lastStudent.admissionNo.split('-');
        if (parts.length >= 3) sequence = parseInt(parts[2]) + 1;
    }

    // Pre-fetch all classes for the school to allow flexible matching
    const schoolClasses = await prisma.class.findMany({
        where: { schoolId },
        select: { id: true, name: true, level: true }
    });
    // Map cleaned class name (no spaces, lowercase) to the actual class object
    const classMap = new Map();
    schoolClasses.forEach(c => {
        const cleanName = c.name.replace(/\s+/g, '').toLowerCase();
        classMap.set(cleanName, c);
    });

    const created = [];
    const failed = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;

        try {
            const name = String(row.name || '').trim();
            const gender = String(row.gender || '').trim();
            const className = String(row.className || '').trim();

            if (!name || !className) {
                failed.push({ row: rowNum, reason: 'Missing required fields: name, className' });
                continue;
            }

            // Verify className exists (insensitive to case and whitespace)
            const cleanInputName = className.replace(/\s+/g, '').toLowerCase();
            const cls = classMap.get(cleanInputName);
            
            if (!cls) {
                failed.push({ row: rowNum, reason: `Class "${className}" not found in your school` });
                continue;
            }

            let admissionNo = String(row.admissionNo || '').trim();
            if (!admissionNo) {
                const formattedSequence = sequence.toString().padStart(4, '0');
                admissionNo = `SKL-${currentYear}-${formattedSequence}`;
            }
            const publicId = `STU-${crypto.randomUUID().slice(0, 8).toUpperCase()}-${Date.now().toString().slice(-4)}`;
            sequence++;

            // Check uniqueness
            const existingAdmission = await prisma.studentProfile.findFirst({ where: { admissionNo, schoolId } });
            if (existingAdmission) {
                failed.push({ row: rowNum, reason: `Admission No "${admissionNo}" already exists` });
                continue;
            }

            const safeName = (name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '') || 'student');
            const formattedSequence = (sequence - 1).toString().padStart(4, '0');
            const generatedEmail = `${safeName}.${formattedSequence}.${schoolTag}@skooly.student`;
            const generatedPassword = generateRandomPassword();
            const hashedPassword = await argon2.hash(generatedPassword);

            await prisma.user.create({
                data: {
                    name,
                    email: generatedEmail,
                    password: hashedPassword,
                    role: 'STUDENT',
                    schoolId,
                    studentProfile: {
                        create: {
                            schoolId,
                            admissionNo,
                            publicId,
                            classLevel: cls.level,
                            classId: cls.id,
                            gender,
                            // arabicName removed
                            phone: String(row.phone || '').trim() || null,
                            dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
                            religion: String(row.religion || '').trim() || null,
                            bloodGroup: String(row.bloodGroup || '').trim() || null,
                            address: String(row.address || '').trim() || null,
                            previousSchool: String(row.previousSchool || '').trim() || null,
                            orphan: String(row.orphan || 'no').toLowerCase() === 'yes',
                            status: 'Active',
                        }
                    }
                }
            });

            created.push({ name, admissionNo, email: generatedEmail, generatedPassword, row: rowNum });
        } catch (err) {
            failed.push({ row: rowNum, reason: err.message });
        }
    }

    res.status(StatusCodes.OK).json({
        msg: `Import complete. ${created.length} created, ${failed.length} failed.`,
        created,
        failed,
        summary: { total: rows.length, created: created.length, failed: failed.length }
    });
};

module.exports = {
    downloadStaffTemplate,
    downloadStudentTemplate,
    bulkImportStaff,
    bulkImportStudents,
};
