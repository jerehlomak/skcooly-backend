const { StatusCodes } = require('http-status-codes');
const { Prisma } = require('@prisma/client');

const errorHandlerMiddleware = (err, req, res, next) => {
  let customError = {
    // set default
    statusCode: err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR,
    msg: err.message || 'Something went wrong try again later',
  };

  // Prisma unique constraint violation (like Mongoose code 11000)
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      customError.msg = `Duplicate value entered for ${err.meta?.target}, please choose another value`;
      customError.statusCode = 400;
    }

    // Prisma record not found
    if (err.code === 'P2025') {
      customError.msg = `No item found for the targeted query`;
      customError.statusCode = 404;
    }
  }

  // Handle generic validation errors that aren't specifically caught
  if (err.name === 'ValidationError') {
    customError.msg = err.message;
    customError.statusCode = 400;
  }

  return res.status(customError.statusCode).json({ msg: customError.msg });
};

module.exports = errorHandlerMiddleware;
