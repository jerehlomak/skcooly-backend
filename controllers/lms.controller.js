const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── ASSIGNMENTS ──────────────────────────────────────────────────────────
const createAssignment = async (req, res) => {
    const { schoolId } = req.user;
    const { classId, subjectId, title, description, dueDate, maxScore, attachments } = req.body;

    let teacherId = null;
    if (req.user.role === 'TEACHER') {
        const teacher = await prisma.teacherProfile.findUnique({ where: { userId: req.user.userId } });
        if (teacher) teacherId = teacher.id;
    }

    const assignment = await prisma.assignment.create({
        data: {
            schoolId,
            classId,
            subjectId,
            teacherId,
            title,
            description,
            dueDate: dueDate ? new Date(dueDate) : null,
            maxScore: parseFloat(maxScore) || 100,
            attachments
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Assignment created successfully', assignment });
};

const getAssignments = async (req, res) => {
    const { classId, subjectId } = req.query;
    
    let whereClause = { schoolId: req.user.schoolId };
    if (classId) whereClause.classId = classId;
    if (subjectId) whereClause.subjectId = subjectId;

    const assignments = await prisma.assignment.findMany({
        where: whereClause,
        include: {
            subject: { select: { name: true } },
            class: { select: { name: true } },
            teacher: { select: { user: { select: { name: true } } } },
            _count: { select: { submissions: true } }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ count: assignments.length, assignments });
};

// ─── SUBMISSIONS ─────────────────────────────────────────────────────────
const submitAssignment = async (req, res) => {
    const { id: assignmentId } = req.params;
    const { attachedFiles } = req.body;

    const student = await prisma.studentProfile.findFirst({
        where: { userId: req.user.userId }
    });
    
    if (!student) {
        throw new CustomError.NotFoundError("Student profile not found");
    }

    const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!assignment) {
        throw new CustomError.NotFoundError("Assignment not found");
    }

    if (assignment.dueDate && new Date() > new Date(assignment.dueDate)) {
        throw new CustomError.BadRequestError("Assignment submission deadline has passed");
    }

    const submission = await prisma.assignmentSubmission.upsert({
        where: {
            assignmentId_studentProfileId: { assignmentId, studentProfileId: student.id }
        },
        update: {
            attachedFiles,
            updatedAt: new Date()
        },
        create: {
            assignmentId,
            studentProfileId: student.id,
            attachedFiles
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Assignment submitted successfully', submission });
};

const gradeSubmission = async (req, res) => {
    const { id: submissionId } = req.params;
    const { score, teacherFeedback } = req.body;

    const submission = await prisma.assignmentSubmission.update({
        where: { id: submissionId },
        data: {
            score: parseFloat(score),
            teacherFeedback
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Submission graded successfully', submission });
};

const getStudentAssignments = async (req, res) => {
    const { studentProfileId } = req.query;
    if (!studentProfileId) throw new CustomError.BadRequestError('Please provide studentProfileId');

    const student = await prisma.studentProfile.findUnique({ where: { id: studentProfileId } });
    if (!student) throw new CustomError.NotFoundError("Student not found");

    const classId = student.currentClassId;

    const assignments = await prisma.assignment.findMany({
        where: { classId },
        include: {
            subject: { select: { name: true } },
            submissions: { where: { studentProfileId } }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ count: assignments.length, assignments });
};

// ─── LESSON RESOURCES ────────────────────────────────────────────────────
const createLessonResource = async (req, res) => {
    const { schoolId } = req.user;
    const { classId, subjectId, title, type, fileUrl, description } = req.body;

    let teacherId = null;
    if (req.user.role === 'TEACHER') {
        const teacher = await prisma.teacherProfile.findUnique({ where: { userId: req.user.userId } });
        if (teacher) teacherId = teacher.id;
    }

    const lesson = await prisma.lessonResource.create({
        data: {
            schoolId,
            classId,
            subjectId,
            teacherId,
            title,
            type, // 'PDF', 'VIDEO', 'LINK'
            fileUrl,
            description
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Lesson resource added successfully', lesson });
};

const getLessonResources = async (req, res) => {
    const { classId, subjectId } = req.query;
    
    let whereClause = { schoolId: req.user.schoolId };
    if (classId) whereClause.classId = classId;
    if (subjectId) whereClause.subjectId = subjectId;

    const lessons = await prisma.lessonResource.findMany({
        where: whereClause,
        include: {
            subject: { select: { name: true } },
            class: { select: { name: true } },
            teacher: { select: { user: { select: { name: true } } } }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ count: lessons.length, lessons });
};

module.exports = {
    createAssignment,
    getAssignments,
    submitAssignment,
    gradeSubmission,
    getStudentAssignments,
    createLessonResource,
    getLessonResources
};
