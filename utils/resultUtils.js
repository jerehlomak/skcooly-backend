/**
 * Applies position ranking to an array of objects based on a primary key and optional secondary key.
 * Modifies the array in place, adding a `position` property to each object.
 * 
 * @param {Array} arr The array of objects to rank
 * @param {String} primaryKey The key for the primary metric (e.g. 'avg', 'score', 'average')
 * @param {String} secondaryKey The key for the total score metric (e.g. 'total') to use as tie breaker
 * @param {String} strategy 'standard' (1, 2, 2, 4) or 'dense' (1, 2, 2, 3)
 * @param {String} tieBreaker 'total', 'average', or 'none'
 * @returns {Array} The same array sorted and with .position assigned
 */
const applyRanking = (arr, primaryKey, secondaryKey, strategy = 'standard', tieBreaker = 'total') => {
    if (!arr || !Array.isArray(arr)) return [];

    // For subjects (no secondaryKey), force tieBreaker to 'none'
    if (!secondaryKey) tieBreaker = 'none';

    // Determine actual primary and secondary keys based on tieBreaker
    // Usually, tieBreaker 'total' means primary is 'average' and secondary is 'total'.
    // If tieBreaker is 'average', the school wants 'total' as primary and 'average' as secondary.
    let actualPrimary = primaryKey;
    let actualSecondary = secondaryKey;

    if (tieBreaker === 'average' && secondaryKey) {
        actualPrimary = secondaryKey;
        actualSecondary = primaryKey;
    }

    // 1. Sort the array descending
    arr.sort((a, b) => {
        const pA = Number(a[actualPrimary]) || 0;
        const pB = Number(b[actualPrimary]) || 0;
        if (pB !== pA) return pB - pA;
        
        if (tieBreaker !== 'none' && actualSecondary) {
            const sA = Number(a[actualSecondary]) || 0;
            const sB = Number(b[actualSecondary]) || 0;
            if (sB !== sA) return sB - sA;
        }
        return 0; // True tie
    });

    // 2. Assign ranks
    let currentRank = 1;
    let actualRank = 1;
    let prevPrimary = null;
    let prevSecondary = null;

    arr.forEach((item, index) => {
        const pVal = Number(item[actualPrimary]) || 0;
        const sVal = (tieBreaker !== 'none' && actualSecondary) ? (Number(item[actualSecondary]) || 0) : null;

        const isTie = prevPrimary !== null && pVal === prevPrimary && sVal === prevSecondary;
        
        if (isTie) {
            item.position = currentRank;
        } else {
            currentRank = strategy === 'dense' ? (index === 0 ? 1 : currentRank + 1) : actualRank;
            item.position = currentRank;
        }
        
        prevPrimary = pVal;
        prevSecondary = sVal;
        actualRank++;
    });

    return arr;
};

module.exports = {
    applyRanking
};
