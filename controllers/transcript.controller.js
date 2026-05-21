const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');
const { generateTranscriptPDF } = require('../services/pdf.service');

// ─── GENERATE STUDENT TRANSCRIPT ───────────────────────────────────────
const generateTranscript = async (req, res) => {
    const { studentId } = req.params;
    const schoolId = req.user.schoolId;

    // Check permissions
    if (req.user.role === 'PARENT') {
        const schoolSettings = await prisma.schoolSettings.findFirst({ where: { schoolId } });
        if (!schoolSettings || !schoolSettings.parentTranscriptAccess) {
            throw new CustomError.ForbiddenError('Transcripts are not currently available for download by parents.');
        }
        
        // Ensure the parent is actually requesting their own child's transcript
        const student = await prisma.studentProfile.findUnique({
            where: { id: studentId },
            include: { parent: true }
        });

        if (!student || student.parentProfileId !== req.user.profileId) {
            throw new CustomError.ForbiddenError('You can only download transcripts for your own children.');
        }
    } else if (!['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'].includes(req.user.role)) {
        throw new CustomError.ForbiddenError('You do not have permission to download transcripts.');
    }

    // 1. Fetch Student Info & School Info
    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId, schoolId },
        include: {
            user: true,
            classArm: true
        }
    });

    if (!student) throw new CustomError.NotFoundError(`Student not found`);

    const school = await prisma.school.findUnique({
        where: { id: schoolId }
    });
    
    const settings = await prisma.schoolSettings.findFirst({
        where: { schoolId }
    });

    // 2. Fetch all term results for this student (across all years/terms)
    const allResults = await prisma.studentResult.findMany({
        where: { studentProfileId: studentId, schoolId },
        include: { subject: true },
        orderBy: [
            { academicYear: 'asc' },
            { term: 'asc' }
        ]
    });

    // 3. Process the columns (Year + Term) and scores
    const sessionsTerms = new Set();
    const subjectsMap = {};

    allResults.forEach(r => {
        const colKey = `${r.academicYear} - ${r.term}`;
        sessionsTerms.add(colKey);

        const subjName = r.subject.name;
        if (!subjectsMap[subjName]) {
            subjectsMap[subjName] = {};
        }
        subjectsMap[subjName][colKey] = r.totalScore;
    });

    const columns = Array.from(sessionsTerms);
    
    // Sort columns chronologically if possible (assuming format "YYYY/YYYY - Term")
    // A simple sort works for standardized names
    columns.sort(); 

    const subjectsData = Object.keys(subjectsMap).map(subjName => {
        const scores = columns.map(col => {
            const score = subjectsMap[subjName][col];
            return score !== undefined ? score : null;
        });
        return { name: subjName, scores };
    });

    // 4. Check for Legacy Results for this student's class history
    // (Assuming student belonged to their current class or we check all legacy results for classes they were in)
    // To keep it simple, we fetch legacy results for any class the student has results in.
    const classIds = [...new Set(allResults.map(r => r.classId))];
    
    // Also include their current class
    if (student.classId && !classIds.includes(student.classId)) {
        classIds.push(student.classId);
    }

    const legacyResults = await prisma.legacyResult.findMany({
        where: { 
            schoolId, 
            classId: { in: classIds } 
        },
        include: { class: true }
    });

    const notes = legacyResults.map(lr => `Historical record imported for ${lr.class.name} (${lr.academicYear} ${lr.term}) from previous platform.`);
    const uniqueNotes = [...new Set(notes)];

    // 5. Structure data for PDF Service
    const pdfData = {
        school: {
            name: settings?.schoolName || school.name,
            motto: settings?.tagline || '',
            address: settings?.address || school.address || '',
            phone: settings?.phone || school.phone || '',
            email: settings?.email || school.email || '',
            logoUrl: settings?.logoUrl || school.logoUrl || ''
        },
        student: {
            name: student.user.name,
            admissionNo: student.admissionNo || 'N/A',
            gender: student.gender || 'N/A',
            dob: student.dateOfBirth ? new Date(student.dateOfBirth).toLocaleDateString() : '—',
            admissionDate: student.createdAt ? new Date(student.createdAt).toLocaleDateString() : '—',
            class: student.classArm ? student.classArm.name : '—'
        },
        columns: columns,
        subjects: subjectsData,
        notes: uniqueNotes
    };

    // 6. Generate PDF
    const pdfBuffer = await generateTranscriptPDF(pdfData);

    res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${student.user.name.replace(/\s+/g, '_')}_Transcript.pdf"`,
        'Content-Length': pdfBuffer.length
    });

    res.status(StatusCodes.OK).end(pdfBuffer);
};

module.exports = {
    generateTranscript
};
