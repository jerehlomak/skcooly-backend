const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');

// List all school types
const listSchoolTypes = async (req, res) => {
  const types = await prisma.schoolType.findMany({ orderBy: { name: 'asc' } });
  res.status(StatusCodes.OK).json({ types });
};

// Create a new school type
const createSchoolType = async (req, res) => {
  const { name, description, isDefault, defaultClasses } = req.body;
  if (!name) throw new CustomError.BadRequestError('Name is required');
  const existing = await prisma.schoolType.findUnique({ where: { name } });
  if (existing) throw new CustomError.BadRequestError('School type already exists');
  const type = await prisma.schoolType.create({
    data: {
      name,
      description,
      isDefault: !!isDefault,
      defaultClasses: defaultClasses || []
    }
  });
  res.status(StatusCodes.CREATED).json({ type });
};

// Update a school type
const updateSchoolType = async (req, res) => {
  const { id } = req.params;
  const { name, description, isDefault, defaultClasses } = req.body;
  const type = await prisma.schoolType.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(isDefault !== undefined && { isDefault }),
      ...(defaultClasses !== undefined && { defaultClasses }),
    },
  });
  res.status(StatusCodes.OK).json({ type });
};

// Delete a school type
const deleteSchoolType = async (req, res) => {
  const { id } = req.params;
  // prevent deletion if any SchoolSettings reference it
  const count = await prisma.schoolSettings.count({ where: { schoolTypeId: id } });
  if (count > 0) throw new CustomError.BadRequestError('Cannot delete type in use');
  await prisma.schoolType.delete({ where: { id } });
  res.status(StatusCodes.OK).json({ msg: 'School type deleted' });
};

// Set a school type as default (ensures only one default)
const setDefaultSchoolType = async (req, res) => {
  const { id } = req.params;
  // Start a transaction to ensure atomicity
  await prisma.$transaction([
    prisma.schoolType.updateMany({ data: { isDefault: false } }),
    prisma.schoolType.update({ where: { id }, data: { isDefault: true } })
  ]);
  res.status(StatusCodes.OK).json({ msg: 'Default school type set' });
};
module.exports = {
  listSchoolTypes,
  createSchoolType,
  updateSchoolType,
  deleteSchoolType,
  setDefaultSchoolType,
};
