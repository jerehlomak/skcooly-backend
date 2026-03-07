
const prisma = require('../db/prisma');
const argon2 = require('argon2');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');

const generateRandomPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
};

// ─── ADD PARENT ───────────────────────────────────────────────────────────────
const addParent = async (req, res) => {
    const {
        name, phone,
        fatherName, fatherPhone, fatherNationalId, fatherOccupation, fatherEducation,
        motherName, motherPhone, motherNationalId, motherOccupation, motherEducation,
        address, occupation
    } = req.body;

    if (!name || !phone) {
        throw new CustomError.BadRequestError('Please provide name and phone number');
    }

    const currentYear = new Date().getFullYear();

    const lastParent = await prisma.parentProfile.findFirst({
        where: { parentId: { startsWith: `PRT-${currentYear}-` } },
        orderBy: { user: { createdAt: 'desc' } }
    });

    let sequence = 1;
    if (lastParent && lastParent.parentId) {
        const parts = lastParent.parentId.split('-');
        if (parts.length === 3) sequence = parseInt(parts[2]) + 1;
    }

    const formattedSeq = sequence.toString().padStart(4, '0');
    const parentId = `PRT-${currentYear}-${formattedSeq}`;

    const safeName = name.toLowerCase().replace(/\s+/g, '.');
    const generatedEmail = `${safeName}.p${formattedSeq}@skooly.parent`;
    const generatedPassword = generateRandomPassword();
    const hashedPassword = await argon2.hash(generatedPassword);

    const newParent = await prisma.$transaction(async (tx) => {
        return await tx.user.create({
            data: {
                name,
                email: generatedEmail,
                password: hashedPassword,
                role: 'PARENT',
                parentProfile: {
                    create: {
                        parentId,
                        phone,
                        address: address || null,
                        occupation: occupation || null,
                        // Father / Primary Guardian
                        fatherName: fatherName || null,
                        fatherPhone: fatherPhone || null,
                        fatherNationalId: fatherNationalId || null,
                        fatherOccupation: fatherOccupation || null,
                        fatherEducation: fatherEducation || null,
                        // Mother / Secondary Guardian
                        motherName: motherName || null,
                        motherPhone: motherPhone || null,
                        motherNationalId: motherNationalId || null,
                        motherOccupation: motherOccupation || null,
                        motherEducation: motherEducation || null
                    }
                }
            },
            select: { id: true, name: true, email: true, role: true, parentProfile: true }
        });
    });

    res.status(StatusCodes.CREATED).json({
        msg: 'Parent account created securely',
        parent: newParent,
        credentials: { parentId, loginEmail: generatedEmail, generatedPassword }
    });
};

// ─── GET ALL PARENTS ──────────────────────────────────────────────────────────
const getAllParents = async (req, res) => {
    const parents = await prisma.parentProfile.findMany({
        include: {
            user: { select: { id: true, name: true, email: true, role: true } },
            students: {
                include: { user: { select: { name: true } } }
            }
        },
        orderBy: { user: { createdAt: 'desc' } }
    });
    res.status(StatusCodes.OK).json({ parents, count: parents.length });
};

// ─── GET SINGLE PARENT ────────────────────────────────────────────────────────
const getParent = async (req, res) => {
    const { id } = req.params; // User.id
    const user = await prisma.user.findUnique({
        where: { id },
        include: {
            parentProfile: {
                include: {
                    students: { include: { user: { select: { name: true } } } }
                }
            }
        }
    });
    if (!user || !user.parentProfile) {
        throw new CustomError.NotFoundError(`No parent found with id: ${id}`);
    }
    res.status(StatusCodes.OK).json({ parent: user.parentProfile, user });
};

// ─── UPDATE PARENT ────────────────────────────────────────────────────────────
const updateParent = async (req, res) => {
    const { id } = req.params; // User.id
    const {
        name, phone, address, occupation,
        fatherName, fatherPhone, fatherNationalId, fatherOccupation, fatherEducation,
        motherName, motherPhone, motherNationalId, motherOccupation, motherEducation
    } = req.body;

    await prisma.user.update({
        where: { id },
        data: {
            ...(name && { name }),
            parentProfile: {
                update: {
                    ...(phone && { phone }),
                    ...(address !== undefined && { address }),
                    ...(occupation !== undefined && { occupation }),
                    ...(fatherName !== undefined && { fatherName }),
                    ...(fatherPhone !== undefined && { fatherPhone }),
                    ...(fatherNationalId !== undefined && { fatherNationalId }),
                    ...(fatherOccupation !== undefined && { fatherOccupation }),
                    ...(fatherEducation !== undefined && { fatherEducation }),
                    ...(motherName !== undefined && { motherName }),
                    ...(motherPhone !== undefined && { motherPhone }),
                    ...(motherNationalId !== undefined && { motherNationalId }),
                    ...(motherOccupation !== undefined && { motherOccupation }),
                    ...(motherEducation !== undefined && { motherEducation })
                }
            }
        }
    });

    res.status(StatusCodes.OK).json({ msg: 'Parent updated successfully' });
};

// ─── DELETE PARENT ────────────────────────────────────────────────────────────
const deleteParent = async (req, res) => {
    const { id } = req.params;
    await prisma.user.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Parent deleted securely' });
};

module.exports = { addParent, getAllParents, getParent, updateParent, deleteParent };
