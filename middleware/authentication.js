const CustomError = require('../errors')
const { isTokenValid } = require('../utils')
const prisma = require('../db/prisma')

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

const requirePermission = (requiredPerm) => {
    return async (req, res, next) => {
        try {
            // Super admins and school admins bypass granular permission checks
            if (['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'].includes(req.user.role)) {
                return next();
            }
            
            const user = await prisma.user.findUnique({
                where: { id: req.user.userId },
                include: { customRole: true }
            });
            
            if (user?.customRole?.permissions?.includes(requiredPerm)) {
                return next();
            }
            
            throw new CustomError.UnauthorizedError(`Permission denied. Requires: ${requiredPerm}`);
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