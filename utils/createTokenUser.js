const createTokenUser = (user) => {
    return {
        name: user.name,
        userId: user.id,
        role: user.role,
        schoolId: user.schoolId || null,
        branchId: user.branchId || null, // Phase 1: null = school-scope, set = branch-restricted
    }
}

module.exports = createTokenUser