const crypto = require('crypto')

/**
 * Generates a readable alphanumeric string of given length.
 * Excludes ambiguous chars: I, L, O, 0, 1.
 */
function generatePinString(length = 10) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    let pin = ''
    for (let i = 0; i < length; i++) {
        const randomIndex = crypto.randomInt(0, chars.length)
        pin += chars[randomIndex]
    }
    return pin
}

/**
 * Generates an array of `quantity` UNIQUE pins, verifying against the DB to ensure 
 * zero collisions across the entire platform.
 * 
 * @param {import('@prisma/client').PrismaClient} prisma 
 * @param {number} quantity 
 * @param {number} length 
 * @returns {Promise<string[]>}
 */
async function generateUniquePins(prisma, quantity, length = 10) {
    // 1. Generate unique set in memory first
    const inMemorySet = new Set()
    while (inMemorySet.size < quantity) {
        inMemorySet.add(generatePinString(length))
    }
    const pinArray = Array.from(inMemorySet)

    // 2. Query DB to check if any of these already exist
    const existing = await prisma.schoolPin.findMany({
        where: { pinCode: { in: pinArray } },
        select: { pinCode: true }
    })

    if (existing.length > 0) {
        // 3. Collision detected! Filter them out and regenerate the missing amount recursively
        const existingSet = new Set(existing.map(e => e.pinCode))
        const cleanPins = pinArray.filter(p => !existingSet.has(p))
        const needed = quantity - cleanPins.length
        
        const additionalPins = await generateUniquePins(prisma, needed, length)
        return [...cleanPins, ...additionalPins]
    }

    return pinArray
}

module.exports = {
    generatePinString,
    generateUniquePins
}
