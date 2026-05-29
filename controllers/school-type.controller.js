const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const prisma = require('../db/prisma');

// List school types — scoped to the requesting school only
const listSchoolTypes = async (req, res) => {
  const schoolId = req.user.schoolId;
  const types = await prisma.schoolType.findMany({
    where: { schoolId },
    orderBy: { name: 'asc' }
  });
  res.status(StatusCodes.OK).json({ types });
};

// Create a new school type — always scoped to the requesting school
const createSchoolType = async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, description, isDefault, defaultClasses } = req.body;
  if (!name) throw new CustomError.BadRequestError('Name is required');

  const existing = await prisma.schoolType.findUnique({
    where: { schoolId_name: { schoolId, name } }
  });
  if (existing) throw new CustomError.BadRequestError('A school type with this name already exists for your school');

  const type = await prisma.schoolType.create({
    data: {
      name,
      description,
      isDefault: !!isDefault,
      defaultClasses: defaultClasses || [],
      schoolId
    }
  });
  res.status(StatusCodes.CREATED).json({ type });
};

// Update a school type — must belong to the requesting school
const updateSchoolType = async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;
  const { name, description, isDefault, defaultClasses } = req.body;

  const existing = await prisma.schoolType.findFirst({ where: { id, schoolId } });
  if (!existing) throw new CustomError.NotFoundError('School type not found');

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

// Delete a school type — must belong to the requesting school
const deleteSchoolType = async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  const existing = await prisma.schoolType.findFirst({ where: { id, schoolId } });
  if (!existing) throw new CustomError.NotFoundError('School type not found');

  // Prevent deletion if any SchoolSettings reference it
  const count = await prisma.schoolSettings.count({ where: { schoolTypeId: id } });
  if (count > 0) throw new CustomError.BadRequestError('Cannot delete a school type that is currently in use');

  await prisma.schoolType.delete({ where: { id } });
  res.status(StatusCodes.OK).json({ msg: 'School type deleted' });
};

// Set a school type as default — scoped to the requesting school
const setDefaultSchoolType = async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  const existing = await prisma.schoolType.findFirst({ where: { id, schoolId } });
  if (!existing) throw new CustomError.NotFoundError('School type not found');

  await prisma.$transaction([
    prisma.schoolType.updateMany({ where: { schoolId }, data: { isDefault: false } }),
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
