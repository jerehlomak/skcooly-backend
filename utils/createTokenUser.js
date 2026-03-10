const createTokenUser = (user) => {
    return { name: user.name, userId: user.id, role: user.role, schoolId: user.schoolId || null }
}

module.exports = createTokenUser