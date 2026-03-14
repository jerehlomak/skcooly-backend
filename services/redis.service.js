const Redis = require('ioredis');

// Connect to Redis only if REDIS_URL is provided or in production
const hasRedis = !!process.env.REDIS_URL || process.env.NODE_ENV === 'production';

let redis = null;
if (hasRedis) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null, // Required by bullmq
        retryStrategy: (times) => {
            return Math.min(times * 50, 2000);
        }
    });

    redis.on('error', (err) => {
        console.error('[Redis Client] Error connecting to Redis:', err.message);
    });

    redis.on('connect', () => {
        console.log('[Redis Client] Successfully connected to Redis');
    });
}

/**
 * Cache Wrapper for Prisma Queries
 * Fallback to direct Prisma query if Redis is down or not configured
 */
const getCache = async (key) => {
    if (!redis) return null;
    try {
        const data = await redis.get(key);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        console.warn(`[Redis Cache] get failed for key ${key}:`, err.message);
        return null;
    }
};

const setCache = async (key, value, ttlSeconds = 3600) => {
    if (!redis) return;
    try {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
        console.warn(`[Redis Cache] set failed for key ${key}:`, err.message);
    }
};

const invalidateCache = async (keyPattern) => {
    if (!redis) return;
    try {
        const keys = await redis.keys(keyPattern);
        if (keys.length > 0) {
            await redis.del(...keys);
        }
    } catch (err) {
        console.warn(`[Redis Cache] invalidate failed for pattern ${keyPattern}:`, err.message);
    }
};

module.exports = {
    redis,
    getCache,
    setCache,
    invalidateCache
};
