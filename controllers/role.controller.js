const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');

// ─── GET ALL ROLES ────────────────────────────────────────────────────────────
const getAllRoles = async (req, res) => {
    const roles = await prisma.customRole.findMany({
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

    const role = await prisma.customRole.create({
        data: {
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

    const existingRole = await prisma.customRole.findUnique({ where: { id } });
    if (!existingRole) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No role found with id ${id}` });
    }

    if (existingRole.isSystemDefault) {
        return res.status(StatusCodes.FORBIDDEN).json({ msg: 'Cannot edit system default roles' });
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

    const existingRole = await prisma.customRole.findUnique({ where: { id } });
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
        const existing = await prisma.customRole.findUnique({ where: { name: roleData.name } });
        if (!existing) {
            const role = await prisma.customRole.create({ data: roleData });
            createdRoles.push(role);
        }
    }

    res.status(StatusCodes.OK).json({ msg: `Seeded ${createdRoles.length} default roles`, createdRoles });
};

module.exports = {
    getAllRoles,
    createRole,
    updateRole,
    deleteRole,
    seedDefaultRoles
};
