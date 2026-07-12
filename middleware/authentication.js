const CustomError = require('../errors')
const { isTokenValid } = require('../utils')
const prisma = require('../db/prisma')
const { resolveUserAccess } = require('../services/permissions.service')

const authenticateUser = async (req, res, next) => {
    let token = req.signedCookies?.token;

    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    }
    
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        throw new CustomError.UnauthenticatedError('Authentication Invalid')
    }
    try {
        const payload = isTokenValid({ token })

        if (payload.schoolId) {
            const school = await prisma.school.findUnique({
                where: { id: payload.schoolId },
                select: { status: true }
            })
            if (school && school.status === 'SUSPENDED') {
                res.cookie('token', '', {
                    httpOnly: true,
                    expires: new Date(Date.now())
                })
                throw new CustomError.UnauthenticatedError('Your school account has been suspended. Please contact platform support.')
            }
        }

        let activeBranchId = payload.branchId || null;

        // Phase 2: Super Admin Context Switching
        if (payload.role === 'SCHOOL_SUPER_ADMIN') {
            const requestedBranch = req.headers['x-active-branch'];
            if (requestedBranch && requestedBranch !== 'all') {
                activeBranchId = requestedBranch;
            }
        }

        req.user = {
            name: payload.name,
            userId: payload.userId,
            role: payload.role,
            schoolId: payload.schoolId || null,
            groupId: payload.groupId || null,
            branchId: payload.branchId || null,       // Phase 1: assigned branch
            activeBranchId: activeBranchId,           // Phase 2: viewed branch
            originalSchoolId: payload.originalSchoolId || null  // Branch switching: true home school
        }
        next()
    } catch (error) {
        if (error instanceof CustomError.UnauthenticatedError) {
            throw error;
        }
        throw new CustomError.UnauthenticatedError('Authentication Invalid')
    }

}

const authorizePermissions = (...roles) => {
    return (req, res, next) => {
        const allowedRoles = [...roles];
        // Automatically allow modern admin roles if the legacy 'ADMIN' role is allowed
        if (allowedRoles.includes('ADMIN')) {
            allowedRoles.push('SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN');
        }

        if (!allowedRoles.includes(req.user.role)) {
            throw new CustomError.UnauthorizedError('Unauthorized to access this route');
        }
        next();
    };
};

// Three-layer RBAC gate: dashboard enabled (Layer 1) -> school subscribed (Layer 2)
// -> role has this permission (Layer 3). Backed by a per-user resolved & cached
// permission set (see services/permissions.service.js) so this is a plain
// array-includes check on the hot path, not a fresh DB round-trip per request.
const requirePermission = (permissionKey) => {
    return async (req, res, next) => {
        try {
            const { permissions } = await resolveUserAccess(req.user.userId);
            if (!permissions.includes(permissionKey)) {
                throw new CustomError.UnauthorizedError(`Permission denied. Requires: ${permissionKey}`);
            }
            next();
        } catch (error) {
            next(error);
        }
    };
};

module.exports = {
    authenticateUser,
    authorizePermissions,
    requirePermission
}