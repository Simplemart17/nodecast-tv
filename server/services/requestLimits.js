function requestLimit(maximum, windowMs = 60000) {
    const buckets = new Map();
    return (req, res, next) => {
        const now = Date.now(), key = String(req.user?.id ?? req.ip);
        for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
        let bucket = buckets.get(key);
        if (!bucket) {
            if (buckets.size >= 10000) return res.status(429).json({ error: 'Try again shortly' });
            bucket = { count: 0, until: now + windowMs };
            buckets.set(key, bucket);
        }
        if (++bucket.count > maximum) {
            res.setHeader('Retry-After', Math.ceil((bucket.until - now) / 1000));
            return res.status(429).json({ error: 'Too many requests; try again shortly' });
        }
        next();
    };
}
module.exports = { requestLimit };
