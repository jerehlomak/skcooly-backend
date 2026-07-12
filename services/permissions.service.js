// Resolves a user's effective access under the three-layer RBAC system:
//   Layer 1 — SchoolDashboard: is this dashboard type enabled for the school at all?
//   Layer 2 — SchoolFeature: is this specific menu item included in the school's subscription?
//   Layer 3 — RolePermission: has the user's custom role been ticked for this item?
//
// Only STAFF-dashboard permissions are role-gated (Layer 3) — Teacher/Student/Parent
// portals are governed by Layer 1 only in this build. ADMIN/SCHOOL_SUPER_ADMIN/SCHOOL_ADMIN
// (all tenant-level admin tiers — ADMIN is the legacy role name, superseded by but
// equivalent to SCHOOL_SUPER_ADMIN/SCHOOL_ADMIN, same grouping `authorizePermissions`
// already uses) bypass Layer 3 only — bound by subscription, not by role-ticking.
// Platform staff (Skooly's own team) authenticate via the entirely separate
// CentralAdmin table/middleware, not through this User-based resolution at all.

const prisma = require('../db/prisma');
const { getCache, setCache, invalidateCache } = require('./redis.service');

const ACCESS_CACHE_TTL = 3600; // seconds
const ALL_DASHBOARD_TYPES = ['STUDENT', 'PARENT', 'TEACHER', 'STAFF'];
const SCHOOL_ADMIN_TIER = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];

const accessCacheKey = (userId) => `access:${userId}`;

async function resolveEnabledDashboards(schoolId) {
    if (!schoolId) return ALL_DASHBOARD_TYPES;
    const rows = await prisma.schoolDashboard.findMany({ where: { schoolId } });
    const overrides = new Map(rows.map((r) => [r.dashboardType, r.enabled]));
    // A dashboard type with no row yet defaults to enabled (matches SchoolDashboard.enabled @default(true)).
    return ALL_DASHBOARD_TYPES.filter((dt) => (overrides.has(dt) ? overrides.get(dt) : true));
}

/**
 * Computes { permissions: string[], enabledDashboards: DashboardType[] } for a user.
 * `permissions` is the flat set of Permission.key values the user can currently use
 * (STAFF dashboard only). Cached under `access:{userId}`.
 */
async function resolveUserAccess(userId) {
    const cached = await getCache(accessCacheKey(userId));
    if (cached) return cached;

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, schoolId: true, customRoleId: true },
    });
    if (!user) return { permissions: [], enabledDashboards: [] };

    const enabledDashboards = await resolveEnabledDashboards(user.schoolId);

    let permissions = [];
    if (user.schoolId && enabledDashboards.includes('STAFF')) {
        const [staffPermissions, subscribedRows] = await Promise.all([
            prisma.permission.findMany({ where: { dashboardType: 'STAFF', isActive: true } }),
            prisma.schoolFeature.findMany({ where: { schoolId: user.schoolId, enabled: true }, select: { permissionId: true } }),
        ]);
        const subscribedIds = new Set(subscribedRows.map((r) => r.permissionId));

        // Precedence: an assigned custom role ALWAYS constrains the user, even if
        // their role enum is an admin tier. This is deliberate — administrative
        // staff (staffType ADMIN/ADMINISTRATIVE) are created with role='ADMIN' by
        // teacher.controller.js, but once a school admin assigns them a custom
        // role, that role is the source of truth for their access. Only admin-tier
        // users WITHOUT a custom role are unrestricted (bound by subscription only).
        let grantedIds;
        if (user.customRoleId) {
            const rolePerms = await prisma.rolePermission.findMany({
                where: { customRoleId: user.customRoleId },
                select: { permissionId: true },
            });
            grantedIds = new Set(rolePerms.filter((rp) => subscribedIds.has(rp.permissionId)).map((rp) => rp.permissionId));
        } else if (SCHOOL_ADMIN_TIER.includes(user.role)) {
            grantedIds = subscribedIds; // unrestricted admin — bound by subscription only
        } else {
            grantedIds = new Set();
        }

        permissions = staffPermissions.filter((p) => grantedIds.has(p.id)).map((p) => p.key);
    }

    const result = { permissions, enabledDashboards };
    await setCache(accessCacheKey(userId), result, ACCESS_CACHE_TTL);
    return result;
}

async function invalidateUserAccess(userId) {
    await invalidateCache(accessCacheKey(userId));
}

async function invalidateSchoolAccess(schoolId) {
    const users = await prisma.user.findMany({ where: { schoolId }, select: { id: true } });
    await Promise.all(users.map((u) => invalidateUserAccess(u.id)));
}

async function invalidateRoleAccess(customRoleId) {
    const users = await prisma.user.findMany({ where: { customRoleId }, select: { id: true } });
    await Promise.all(users.map((u) => invalidateUserAccess(u.id)));
}

module.exports = {
    resolveUserAccess,
    invalidateUserAccess,
    invalidateSchoolAccess,
    invalidateRoleAccess,
};
