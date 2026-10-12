const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');

router.use(auth.requireAuth, auth.requireAdmin);
function publicUser(user) {
    return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}
function fail(res, error) {
    const status = /Username already exists|last admin/.test(error.message) ? 400 : 500;
    res.status(status).json({ error: status === 400 ? error.message : 'Server error' });
}
router.get('/', async (req, res) => {
    try { res.json((await db.users.getAll()).map(publicUser)); }
    catch (error) { fail(res, error); }
});
router.post('/', async (req, res) => {
    try {
        const { username, password, role } = req.body;
        if (!username || !password || !role) return res.status(400).json({ error: 'Username, password, and role required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be admin or viewer' });
        const user = await db.users.create({ username, passwordHash: await auth.hashPassword(password), role });
        res.json(publicUser(user));
    } catch (error) { fail(res, error); }
});
router.put('/:id', async (req, res) => {
    try {
        if (!await db.users.getById(req.params.id)) return res.status(404).json({ error: 'User not found' });
        const { username, password, role } = req.body;
        const updates = {};
        if (username) updates.username = username;
        if (password) {
            if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
            updates.passwordHash = await auth.hashPassword(password);
        }
        if (role) {
            if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be admin or viewer' });
            updates.role = role;
        }
        res.json(publicUser(await db.users.update(req.params.id, updates)));
    } catch (error) { fail(res, error); }
});
router.delete('/:id', async (req, res) => {
    try {
        if (!await db.users.getById(req.params.id)) return res.status(404).json({ error: 'User not found' });
        if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
        await db.users.delete(req.params.id);
        res.json({ success: true });
    } catch (error) { fail(res, error); }
});
module.exports = router;
