const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');

// ─── GET ALL ROLES ────────────────────────────────────────────────────────────
const getAllRoles = async (req, res) => {
    const roles = await prisma.customRole.findMany({
        where: { schoolId: req.user.schoolId },
        orderBy: { createdAt: 'asc' }
    });
    res.status(StatusCodes.OK).json({ roles, count: roles.length });
};

// ─── CREATE ROLE ──────────────────────────────────────────────────────────────
const createRole = async (req, res) => {
    const { name, description, permissions } = req.body;
    if (!name) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Role name is required' });
    }

    const existingName = await prisma.customRole.findFirst({
        where: { schoolId: req.user.schoolId, name: name.trim() }
    });
    if (existingName) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: `Role "${name.trim()}" already exists. Please choose a different name.` });
    }

    const role = await prisma.customRole.create({
        data: {
            schoolId: req.user.schoolId,
            name: name.trim(),
            description: description || '',
            permissions: permissions || [],
            isSystemDefault: false
        }
    });
    res.status(StatusCodes.CREATED).json({ role });
};

// ─── UPDATE ROLE ──────────────────────────────────────────────────────────────
const updateRole = async (req, res) => {
    const { id } = req.params;
    const { name, description, permissions } = req.body;

    const existingRole = await prisma.customRole.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!existingRole) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No role found with id ${id}` });
    }

    if (existingRole.isSystemDefault) {
        return res.status(StatusCodes.FORBIDDEN).json({ msg: 'Cannot edit system default roles' });
    }

    if (name) {
        const existingName = await prisma.customRole.findFirst({
            where: { schoolId: req.user.schoolId, name: name.trim(), id: { not: id } }
        });
        if (existingName) {
            return res.status(StatusCodes.BAD_REQUEST).json({ msg: `Role "${name.trim()}" already exists.` });
        }
    }

    const role = await prisma.customRole.update({
        where: { id },
        data: {
            ...(name !== undefined && { name: name.trim() }),
            ...(description !== undefined && { description }),
            ...(permissions !== undefined && { permissions }),
        }
    });
    res.status(StatusCodes.OK).json({ role });
};

// ─── DELETE ROLE ──────────────────────────────────────────────────────────────
const deleteRole = async (req, res) => {
    const { id } = req.params;

    const existingRole = await prisma.customRole.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!existingRole) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No role found with id ${id}` });
    }

    if (existingRole.isSystemDefault) {
        return res.status(StatusCodes.FORBIDDEN).json({ msg: 'Cannot delete system default roles' });
    }

    await prisma.customRole.delete({ where: { id } });
    res.status(StatusCodes.OK).json({ msg: 'Role deleted successfully' });
};

// ─── SEED DEFAULT ROLES ───────────────────────────────────────────────────────
const seedDefaultRoles = async (req, res) => {
    const defaultRoles = [
        {
            name: 'Super Admin',
            description: 'Full access to all modules including sensitive financial settings.',
            isSystemDefault: true,
            permissions: [
                'std_view', 'std_add', 'std_edit', 'std_delete',
                'acd_view', 'acd_manage', 'cbt_create', 'cbt_grade',
                'fin_view', 'fin_collect', 'fin_refund', 'fin_salary',
                'adm_staff', 'adm_settings', 'adm_sms'
            ]
        },
        {
            name: 'Form Teacher',
            description: 'Can manage academics for assigned classes and view basic student info.',
            isSystemDefault: true,
            permissions: ['std_view', 'acd_view', 'acd_manage', 'cbt_create', 'cbt_grade']
        },
        {
            name: 'Bursar / Cashier',
            description: 'Dedicated to fee collections and financial reporting only.',
            isSystemDefault: true,
            permissions: ['std_view', 'fin_view', 'fin_collect']
        }
    ];

    const createdRoles = [];
    for (const roleData of defaultRoles) {
        const existing = await prisma.customRole.findFirst({ 
            where: { schoolId: req.user.schoolId, name: roleData.name } 
        });
        if (!existing) {
            const role = await prisma.customRole.create({ 
                data: { ...roleData, schoolId: req.user.schoolId } 
            });
            createdRoles.push(role);
        }
    }

    res.status(StatusCodes.OK).json({ msg: `Seeded ${createdRoles.length} default roles`, createdRoles });
};

// ─── GET PERMISSIONS DICTIONARY ──────────────────────────────────────────────────
const getPermissions = async (req, res) => {
    // A structured dictionary of all available permissions in the system
    const permissions = {
        student: [
            { id: 'std_view', label: 'View Students' },
            { id: 'std_add', label: 'Register Students' },
            { id: 'std_edit', label: 'Edit Students' },
            { id: 'std_delete', label: 'Delete Students' }
        ],
        academic: [
            { id: 'acd_view', label: 'View Academics (Classes/Subjects)' },
            { id: 'acd_manage', label: 'Manage Academics' },
            { id: 'cbt_create', label: 'Create CBT Exams' },
            { id: 'cbt_grade', label: 'Grade CBT Exams' }
        ],
        finance: [
            { id: 'fin_view', label: 'View Financial Records' },
            { id: 'fin_collect', label: 'Collect Fees' },
            { id: 'fin_refund', label: 'Issue Refunds' },
            { id: 'fin_salary', label: 'Manage Payroll' }
        ],
        admin: [
            { id: 'adm_staff', label: 'Manage Staff' },
            { id: 'adm_settings', label: 'School Settings' },
            { id: 'adm_sms', label: 'Send SMS/Communication' },
            { id: 'adm_roles', label: 'Manage Roles & Permissions' }
        ]
    };
    
    res.status(StatusCodes.OK).json({ permissions });
};

module.exports = {
    getAllRoles,
    createRole,
    updateRole,
    deleteRole,
    seedDefaultRoles,
    getPermissions
};
