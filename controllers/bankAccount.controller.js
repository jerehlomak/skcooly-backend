
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes')

// GET all bank accounts
const getBankAccounts = async (req, res) => {
    const banks = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'desc' } })
    res.status(StatusCodes.OK).json({ banks, count: banks.length })
}

// POST new bank account
const addBankAccount = async (req, res) => {
    const { bankName, accountNumber, branchAddress, instructions, logoUrl } = req.body

    if (!bankName || !accountNumber) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: 'Bank Name and Account Number are required' })
    }

    const bank = await prisma.bankAccount.create({
        data: {
            bankName,
            accountNumber,
            branchAddress,
            instructions,
            logoUrl
        }
    })

    res.status(StatusCodes.CREATED).json({ msg: 'Bank Account added successfully', bank })
}

// DELETE a bank account
const deleteBankAccount = async (req, res) => {
    const { id } = req.params

    const bank = await prisma.bankAccount.findUnique({ where: { id } })
    if (!bank) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: `No bank account with id: ${id}` })
    }

    await prisma.bankAccount.delete({ where: { id } })
    res.status(StatusCodes.OK).json({ msg: 'Bank Account deleted successfully' })
}

module.exports = { getBankAccounts, addBankAccount, deleteBankAccount }
