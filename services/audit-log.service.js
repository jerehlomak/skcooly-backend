const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

/**
 * Appends an audit log for operations performed by users inside a School tenant.
 * @param {Object} params
 * @param {string} params.schoolId - The tenant ID
 * @param {string} params.userId - The ID of the user performing the action (Admin/Teacher)
 * @param {string} params.action - The action being performed (e.g., 'CREATE_STUDENT', 'DELETE_RESULT')
 * @param {string} params.entityType - The affected Prisma Model (e.g., 'StudentProfile')
 * @param {string} [params.entityId] - The ID of the modified entity
 * @param {Object} [params.metadata] - Old values or payload data
 * @param {string} [params.ipAddress] - Request IP
 */
const logTenantAction = async ({
    schoolId,
    userId,
    action,
    entityType,
    entityId,
    metadata,
    ipAddress
}) => {
    try {
        if (!schoolId) return // Failsafe

        await prisma.tenantAuditLog.create({
            data: {
                schoolId,
                userId,
                action,
                entityType,
                entityId,
                metadata: metadata ? metadata : undefined,
                ipAddress
            }
        })
    } catch (error) {
        // We log locally but do NOT throw. Audit failures shouldn't block main core logic.
        console.error('[TenantAuditLog Error]', error.message)
    }
}

module.exports = {
    logTenantAction
}
