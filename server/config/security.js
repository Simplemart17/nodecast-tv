const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = process.env.NODECAST_DATA_DIR ? path.resolve(process.env.NODECAST_DATA_DIR) : path.join(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });
const secretPath = path.join(dataDir, 'security.json');
try {
    fs.writeFileSync(secretPath, JSON.stringify({ jwt: crypto.randomBytes(32).toString('base64url'),
        session: crypto.randomBytes(32).toString('base64url') }), { flag: 'wx', mode: 0o600 });
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
}
const persisted = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
if (typeof persisted.jwt !== 'string' || persisted.jwt.length < 32 || typeof persisted.session !== 'string' || persisted.session.length < 32) {
    throw new Error('Invalid persisted authentication secrets');
}
const jwtSecret = process.env.JWT_SECRET || persisted.jwt;
const suffix = crypto.createHash('sha256').update(jwtSecret).digest('hex').slice(0, 12);
module.exports = { jwtSecret, sessionSecret: process.env.SESSION_SECRET || persisted.session,
    authCookieName: `nodecast_auth_${suffix}`, sessionCookieName: `nodecast_session_${suffix}` };
