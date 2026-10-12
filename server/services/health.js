const database = require('../db');
const { getDb } = require('../db/sqlite');

async function health(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.app.locals.ready) return res.status(503).json({ status: 'unavailable' });
    try {
        await database.checkHealth();
        getDb().prepare('SELECT 1').get();
        // Readiness may change while the asynchronous JSON check is running.
        if (!req.app.locals.ready) return res.status(503).json({ status: 'unavailable' });
        res.json({ status: 'ok' });
    } catch {
        res.status(503).json({ status: 'unavailable' });
    }
}

module.exports = health;
