const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const { invalidateRoleAccess } = require('../services/permissions.service');

// ─── GET ALL ROLES ────────────────────────────────────────────────────────────
const getAllRoles = async (req, res) => {
    const roles = await prisma.customRole.findMany({
        where: { schoolId: req.user.schoolId },
        include: { rolePermissions: { include: { permission: true } } },
        orderBy: { createdAt: 'asc' }
    });
    res.status(StatusCodes.OK).json({ roles, count: roles.length });
};

// ─── CREATE ROLE ──────────────────────────────────────────────────────────────
const createRole = async (req, res) => {
    const { name, description, permissionIds } = req.body;
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
            isSystemDefault: false,
            rolePermissions: {
                create: (permissionIds || []).map((permissionId) => ({ permissionId })),
            },
        },
        include: { rolePermissions: { include: { permission: true } } },
    });
    res.status(StatusCodes.CREATED).json({ role });
};

// ─── UPDATE ROLE ──────────────────────────────────────────────────────────────
const updateRole = async (req, res) => {
    const { id } = req.params;
    const { name, description, permissionIds } = req.body;

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

    if (permissionIds !== undefined) {
        await prisma.$transaction([
            prisma.rolePermission.deleteMany({ where: { customRoleId: id } }),
            prisma.rolePermission.createMany({
                data: permissionIds.map((permissionId) => ({ customRoleId: id, permissionId })),
            }),
        ]);
    }

    const role = await prisma.customRole.update({
        where: { id },
        data: {
            ...(name !== undefined && { name: name.trim() }),
            ...(description !== undefined && { description }),
        },
        include: { rolePermissions: { include: { permission: true } } },
    });

    await invalidateRoleAccess(id);
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
    await invalidateRoleAccess(id);
    res.status(StatusCodes.OK).json({ msg: 'Role deleted successfully' });
};

// ─── GET PERMISSIONS CATALOG ──────────────────────────────────────────────────
// Only the STAFF-dashboard menu items the school is actually subscribed to
// (SchoolFeature) — grouped by module, mirroring the real sidebar structure.
// Items the school hasn't subscribed to never appear here, so there's nothing
// to tick for them.
const getPermissions = async (req, res) => {
    const school = await prisma.school.findUnique({
        where: { id: req.user.schoolId },
        include: { plan: true }
    });
    
    let planFeatures = school?.plan?.features || [];
    if (typeof planFeatures === 'string') {
        try { planFeatures = JSON.parse(planFeatures); } catch { planFeatures = []; }
    }

    const subscribedRows = await prisma.schoolFeature.findMany({
        where: { schoolId: req.user.schoolId, enabled: true },
        select: { permissionId: true },
    });
    const subscribedIds = new Set(subscribedRows.map((r) => r.permissionId));

    const allStaffPermissions = await prisma.permission.findMany({
        where: { dashboardType: 'STAFF', isActive: true },
        orderBy: [{ module: 'asc' }, { sortOrder: 'asc' }],
    });

    const grouped = {};
    for (const p of allStaffPermissions) {
        // Skip if the module is not included in the school's active plan
        if (!planFeatures.includes(p.module) && !planFeatures.includes(p.module.toLowerCase())) {
            continue;
        }
        
        // Skip if explicitly disabled via the layer-2 SchoolFeature toggle
        if (!subscribedIds.has(p.id)) continue;

        if (!grouped[p.module]) grouped[p.module] = [];
        grouped[p.module].push({ id: p.id, key: p.key, label: p.label });
    }

    res.status(StatusCodes.OK).json({ permissions: grouped });
};

module.exports = {
    getAllRoles,
    createRole,
    updateRole,
    deleteRole,
    getPermissions
};
