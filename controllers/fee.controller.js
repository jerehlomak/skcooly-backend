const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

/**
 * Assign fees to students based on FeeParticular targets.
 * This generates FeeInvoices, FeeInvoiceItems, and DEBIT StudentLedger entries.
 *
 * Body: { targets: { classLevel?: string, classId?: string, studentIds?: string[] }, feeParticularIds: string[], term: string, year: string, dueDate?: string }
 */
const assignFees = async (req, res) => {
    const { targets, feeParticularIds, term, year, dueDate } = req.body;
    const { schoolId } = req.user;

    if (!feeParticularIds || !Array.isArray(feeParticularIds) || feeParticularIds.length === 0) {
        throw new CustomError.BadRequestError('feeParticularIds array is required');
    }
    if (!term || !year) {
        throw new CustomError.BadRequestError('term and year are required');
    }

    // 1. Fetch the FeeParticulars (exclude deleted ones — only active fee particulars can be assigned)
    const particulars = await prisma.feeParticular.findMany({
        where: { id: { in: feeParticularIds }, schoolId }
    });

    if (particulars.length !== feeParticularIds.length) {
        throw new CustomError.BadRequestError('One or more fee particulars are invalid or not found');
    }

    const totalCalculatedAmount = particulars.reduce((sum, item) => sum + item.amount, 0);

    // 2. Identify target students based on provided targets
    let studentWhereClause = { schoolId, status: 'Active', isDeleted: false };
    
    if (targets) {
        if (targets.studentIds && targets.studentIds.length > 0) {
            studentWhereClause.id = { in: targets.studentIds };
        } else if (targets.classId) {
            studentWhereClause.classId = targets.classId;
        } else if (targets.classLevel) {
            studentWhereClause.classLevel = targets.classLevel;
        } else if (targets.newStudentsSince) {
            // Target students enrolled after the cutoff date (e.g. last 30 days)
            studentWhereClause.enrollmentDate = { gte: new Date(targets.newStudentsSince) };
        }
    }

    const students = await prisma.studentProfile.findMany({
        where: studentWhereClause,
        select: { id: true, user: { select: { name: true } }, classArm: { select: { name: true } } }
    });

    console.log(`[assignFees] Found ${students.length} students matching targets:`, targets);

    if (students.length === 0) {
        return res.status(StatusCodes.OK).json({ 
            msg: 'No active students found matching the targets', 
            stats: { studentsTargeted: 0, invoicesCreated: 0, itemsCreated: 0, ledgerEntriesCreated: 0 } 
        });
    }

    let invoicesCreated = 0;
    let itemsCreated = 0;
    let ledgerEntriesCreated = 0;

    const parsedDueDate = (dueDate && !isNaN(new Date(dueDate).getTime())) ? new Date(dueDate) : null;

    try {
        // 3. Process each student
        for (const student of students) {
            await prisma.$transaction(async (tx) => {
                // Check if an invoice already exists for this term/year
                let invoice = await tx.feeInvoice.findFirst({
                    where: { studentProfileId: student.id, term, year, isDeleted: false },
                    include: { items: true }
                });

                if (!invoice) {
                    // Create new invoice
                    invoice = await tx.feeInvoice.create({
                        data: {
                            schoolId,
                            studentProfileId: student.id,
                            term,
                            year,
                            totalAmount: totalCalculatedAmount,
                            dueDate: parsedDueDate,
                            amountPaid: 0,
                            status: 'Unpaid'
                        },
                        include: { items: true }
                    });
                    invoicesCreated++;
                } else {
                    // Update existing invoice total
                    invoice = await tx.feeInvoice.update({
                        where: { id: invoice.id },
                        data: {
                            totalAmount: invoice.totalAmount + totalCalculatedAmount,
                            status: invoice.amountPaid >= (invoice.totalAmount + totalCalculatedAmount) ? 'Paid' : (invoice.amountPaid > 0 ? 'Partial' : 'Unpaid')
                        },
                        include: { items: true }
                    });
                }

                // Get current balance from the last ledger entry for this student
                const lastLedger = await tx.studentLedger.findFirst({
                    where: { studentProfileId: student.id },
                    orderBy: { createdAt: 'desc' }
                });
                let currentBalance = lastLedger ? lastLedger.balanceAfter : 0;

                // Add the items and ledger entries
                for (const fee of particulars) {
                    const existingItem = (invoice.items || []).find(i => i.feeParticularId === fee.id);
                    if (!existingItem) {
                        await tx.feeInvoiceItem.create({
                            data: {
                                feeInvoiceId: invoice.id,
                                feeParticularId: fee.id,
                                label: fee.label,
                                amount: fee.amount
                            }
                        });
                        itemsCreated++;

                        currentBalance += fee.amount;
                        
                        await tx.studentLedger.create({
                            data: {
                                schoolId,
                                studentProfileId: student.id,
                                type: 'DEBIT',
                                category: 'Fee Assignment',
                                description: `Assigned: ${fee.label} (${term} ${year})`,
                                amount: fee.amount,
                                balanceAfter: currentBalance,
                                feeInvoiceId: invoice.id
                            }
                        });
                        ledgerEntriesCreated++;
                    }
                }
            }, { timeout: 30000 });
        }
    } catch (err) {
        console.error('[assignFees] Error during student processing loop:', err);
        throw err; // Re-throw to be caught by express-async-errors
    }

    res.status(StatusCodes.CREATED).json({
        msg: `Successfully assigned fees parameters.`,
        stats: { studentsTargeted: students.length, invoicesCreated, itemsCreated, ledgerEntriesCreated }
    });
};

/**
 * Get Student Ledger Timeline
 * Retrieves the strict chronological debit/credit ledger for a specific student.
 */
const getStudentLedger = async (req, res) => {
    const { studentId } = req.params;
    
    // Authorization check
    if (req.user.role === 'STUDENT') {
        const profile = await prisma.studentProfile.findUnique({ where: { userId: req.user.userId }});
        if (profile.id !== studentId) throw new CustomError.UnauthorizedError('Cannot view other student ledgers');
    } else if (req.user.role === 'PARENT') {
        const parent = await prisma.parentProfile.findUnique({ where: { userId: req.user.userId }, include: { students: true }});
        if (!parent.students.some(s => s.id === studentId)) {
            throw new CustomError.UnauthorizedError('Cannot view ledger for unlinked student');
        }
    }

    const ledger = await prisma.studentLedger.findMany({
        where: { studentProfileId: studentId },
        orderBy: { createdAt: 'asc' }, // Chronological order to show balance progression
        include: {
            feeInvoice: { select: { term: true, year: true, totalAmount: true, amountPaid: true, status: true } },
            installment: { select: { gateway: true, transactionRef: true } }
        }
    });

    const student = await prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: { id: true, admissionNo: true, user: { select: { name: true } }, classArm: { select: { name: true } } }
    });

    res.status(StatusCodes.OK).json({ student, ledger });
};

module.exports = {
    assignFees,
    getStudentLedger
};
