const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

// ─── QUESTION BANK ────────────────────────────────────────────────────────
const createQuestion = async (req, res) => {
    const { schoolId } = req.user;
    const { subjectId, questionText, type, options, correctAnswer, marks } = req.body;

    const teacherQuery = req.user.role === 'TEACHER' ? { userId: req.user.userId } : {};
    let teacherId = null;
    
    if (req.user.role === 'TEACHER') {
        const teacher = await prisma.teacherProfile.findUnique({ where: teacherQuery });
        if (teacher) teacherId = teacher.id;
    }

    const question = await prisma.questionBank.create({
        data: {
            schoolId,
            subjectId,
            teacherId,
            questionText,
            type,
            options,
            correctAnswer,
            marks: parseInt(marks) || 1
        }
    });

    res.status(StatusCodes.CREATED).json({ msg: 'Question added to bank successfully', question });
};

const getQuestions = async (req, res) => {
    const { subjectId } = req.query;
    
    if (!subjectId) {
        throw new CustomError.BadRequestError('Please provide subjectId');
    }

    const questions = await prisma.questionBank.findMany({
        where: { schoolId: req.user.schoolId, subjectId },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ count: questions.length, questions });
};

// ─── EXAMS ────────────────────────────────────────────────────────────────
const createExam = async (req, res) => {
    const { classId, subjectId, title, instructions, durationMinutes, startTime, endTime, passingMarks, questionIds, status } = req.body;

    // Verify teacher assignment if not admin
    if (req.user.role === 'TEACHER') {
        const teacher = await prisma.teacherProfile.findUnique({ where: { userId: req.user.userId } });
        if (!teacher) throw new CustomError.NotFoundError('Teacher profile not found');
        
        const assignment = await prisma.classSubject.findFirst({
            where: { classId, subjectId, teacherId: teacher.id }
        });
        if (!assignment) {
            throw new CustomError.UnauthorizedError('You are not assigned to this class and subject');
        }
    }

    // 1. Create the Exam
    const exam = await prisma.exam.create({
        data: {
            schoolId: req.user.schoolId,
            classId,
            subjectId,
            title,
            instructions,
            durationMinutes: parseInt(durationMinutes) || 60,
            startTime: startTime ? new Date(startTime) : null,
            endTime: endTime ? new Date(endTime) : null,
            passingMarks: parseInt(passingMarks) || 40,
            status: status || 'DRAFT'
        }
    });

    // 2. Attach Questions (if provided)
    if (questionIds && Array.isArray(questionIds) && questionIds.length > 0) {
        const examQuestionsData = questionIds.map((qId, index) => ({
            examId: exam.id,
            questionId: qId,
            position: index + 1
        }));
        await prisma.examQuestion.createMany({ data: examQuestionsData });
    }

    res.status(StatusCodes.CREATED).json({ msg: 'Exam created successfully', exam });
};

const updateExam = async (req, res) => {
    const { id } = req.params;
    const { title, instructions, durationMinutes, startTime, endTime, passingMarks, status, questionIds } = req.body;

    const exam = await prisma.exam.findUnique({
        where: { id, schoolId: req.user.schoolId }
    });

    if (!exam) throw new CustomError.NotFoundError('Exam not found');

    // Update Exam details
    const updatedExam = await prisma.exam.update({
        where: { id },
        data: {
            ...(title && { title }),
            ...(instructions !== undefined && { instructions }),
            ...(durationMinutes && { durationMinutes: parseInt(durationMinutes) }),
            ...(startTime && { startTime: new Date(startTime) }),
            ...(endTime && { endTime: new Date(endTime) }),
            ...(passingMarks && { passingMarks: parseInt(passingMarks) }),
            ...(status && { status })
        }
    });

    // Update Questions if provided (Sync approach: delete existing, add new)
    if (questionIds && Array.isArray(questionIds)) {
        await prisma.examQuestion.deleteMany({ where: { examId: id } });
        const examQuestionsData = questionIds.map((qId, index) => ({
            examId: id,
            questionId: qId,
            position: index + 1
        }));
        await prisma.examQuestion.createMany({ data: examQuestionsData });
    }

    res.status(StatusCodes.OK).json({ msg: 'Exam updated successfully', exam: updatedExam });
};

const getExamDetail = async (req, res) => {
    const { id } = req.params;

    const exam = await prisma.exam.findUnique({
        where: { id, schoolId: req.user.schoolId },
        include: {
            subject: { select: { name: true } },
            class: { select: { name: true } },
            examQuestions: {
                include: {
                    question: true
                },
                orderBy: { position: 'asc' }
            }
        }
    });

    if (!exam) throw new CustomError.NotFoundError('Exam not found');

    res.status(StatusCodes.OK).json({ exam });
};

const deleteExam = async (req, res) => {
    const { id } = req.params;

    const exam = await prisma.exam.findUnique({
        where: { id, schoolId: req.user.schoolId }
    });

    if (!exam) throw new CustomError.NotFoundError('Exam not found');

    await prisma.exam.delete({ where: { id } });

    res.status(StatusCodes.OK).json({ msg: 'Exam deleted successfully' });
};

const getExams = async (req, res) => {
    const { classId, subjectId } = req.query;
    
    let whereClause = { schoolId: req.user.schoolId };
    
    // If student, force filter by their class
    if (req.user.role === 'STUDENT') {
        const student = await prisma.studentProfile.findFirst({
            where: { userId: req.user.userId }
        });
        if (student && student.classId) {
            whereClause.classId = student.classId;
        } else if (student && student.classLevelId) {
            // Fallback for schools using classLevel for assignments
            whereClause.class = { levelId: student.classLevelId };
        }
    } else {
        if (classId) whereClause.classId = classId;
    }
    
    if (subjectId) whereClause.subjectId = subjectId;

    const exams = await prisma.exam.findMany({
        where: whereClause,
        include: {
            subject: { select: { name: true } },
            class: { select: { name: true } },
            _count: { select: { examQuestions: true } }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ count: exams.length, exams });
};

// ─── STUDENT CBT SUBMISSION ───────────────────────────────────────────────
const submitCBT = async (req, res) => {
    const { id: examId } = req.params;
    const { answers } = req.body; 

    const student = await prisma.studentProfile.findFirst({
        where: { userId: req.user.userId }
    });
    
    if (!student) throw new CustomError.NotFoundError("Student profile not found");

    const exam = await prisma.exam.findUnique({
        where: { id: examId },
        include: {
            examQuestions: { include: { question: true } }
        }
    });

    if (!exam) throw new CustomError.NotFoundError("Exam not found");

    // Auto-grade
    let totalScore = 0;
    let earnedMarks = 0;
    let totalPossibleMarks = 0;
    
    for (const eq of exam.examQuestions) {
        const q = eq.question;
        totalPossibleMarks += q.marks;
        const studentAnswer = answers[q.id];
        
        if (studentAnswer && q.correctAnswer) {
            if (studentAnswer.trim().toLowerCase() === q.correctAnswer.trim().toLowerCase()) {
                earnedMarks += q.marks;
            }
        }
    }

    // Convert to percentage (0-100)
    totalScore = totalPossibleMarks > 0 ? Math.round((earnedMarks / totalPossibleMarks) * 100) : 0;

    const result = await prisma.cBTResult.upsert({
        where: {
            examId_studentProfileId: {
                examId: exam.id,
                studentProfileId: student.id
            }
        },
        update: { answers, totalScore },
        create: {
            examId: exam.id,
            studentProfileId: student.id,
            answers,
            totalScore
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Exam submitted successfully', score: totalScore, result });
};

const getCBTResults = async (req, res) => {
    const { id: examId } = req.params;

    const results = await prisma.cBTResult.findMany({
        where: { examId },
        include: {
            student: { select: { name: true, admissionNo: true } }
        },
        orderBy: { totalScore: 'desc' }
    });

    res.status(StatusCodes.OK).json({ count: results.length, results });
};

const getStudentCBTResults = async (req, res) => {
    const { studentProfileId } = req.query;
    if (!studentProfileId) throw new CustomError.BadRequestError('Please provide studentProfileId');

    const results = await prisma.cBTResult.findMany({
        where: { studentProfileId },
        include: {
            exam: { select: { title: true, durationMinutes: true, passingMarks: true, subject: { select: { name: true } } } }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.status(StatusCodes.OK).json({ count: results.length, results });
};

module.exports = {
    createQuestion,
    getQuestions,
    createExam,
    updateExam,
    deleteExam,
    getExamDetail,
    getExams,
    submitCBT,
    getCBTResults,
    getStudentCBTResults
};
