const CustomError = require('../errors')

const checkPermissions = (requestUser, resourceUserId) => {
    // console.log(requestUser)
    // console.log(resourceUserId)
    // console.log(typeof resourceUserId)
    // unless user is admin you are not allowed to visit a single users route
    if (requestUser.role === 'ADMIN') return;
    if (requestUser.userId === resourceUserId.toString()) return;
    throw new CustomError.UnauthorizedError('Not authorized to access this route')
}

module.exports = checkPermissions