const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

async function serverFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-auth-test-'));
    const root = path.join(__dirname, '..');
    let child, base;
    const stop = async () => {
        if (!child || child.exitCode !== null) return;
        const closed = new Promise(resolve => child.once('close', resolve));
        child.kill();
        await closed;
    };
    const start = async () => {
        child = spawn(process.execPath, ['server/index.js'], { cwd: root,
            env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir,
                NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: '', SESSION_SECRET: '',
                OIDC_ISSUER_URL: '', ALLOW_LOCAL_MEDIA_URLS: 'true', AUTH_COOKIE_SECURE: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        base = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
            child.stdout.on('data', chunk => {
                output += chunk;
                const match = output.match(/server running on http:\/\/localhost:(\d+)/);
                if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
            });
            child.stderr.on('data', chunk => { output += chunk; });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
            child.once('error', reject);
        });
        return base;
    };
    t.after(async () => {
        await stop();
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await start();
    const request = async (endpoint, options = {}) => {
        const response = await fetch(`${base}${endpoint}`, { ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers } });
        const body = await response.text();
        return { status: response.status, body: body ? JSON.parse(body) : null,
            cookie: response.headers.getSetCookie().find(value => value.startsWith('nodecast_auth_')),
            headers: response.headers };
    };
    return { dir, request, start, stop, get base() { return base; } };
}
const post = body => ({ method: 'POST', body: JSON.stringify(body) });

test('real application authenticates cookies and bearer clients, isolates users, and persists revocation', async t => {
    const fixture = await serverFixture(t);
    const { request } = fixture;
    for (const route of ['/api/sources', '/api/proxy/stream?url=http://provider.test/a', '/api/probe',
        '/api/remux', '/api/subtitle', '/api/transcode/sessions', '/api/settings', '/api/history']) {
        assert.equal((await request(route)).status, 401, route);
    }
    const attempts = await Promise.all(['Admin', 'Other'].map(username => request('/api/auth/setup', post({ username, password: 'password123' }))));
    assert.equal(attempts.filter(result => result.status === 201).length, 1);
    const admin = attempts.find(result => result.status === 201);
    const cookie = admin.cookie.split(';')[0];
    assert.match(admin.cookie, /HttpOnly/);
    assert.match(admin.cookie, /SameSite=Lax/);
    assert.equal(admin.body.user.passwordHash, undefined);
    const adminHeaders = { Cookie: cookie };
    assert.equal((await request('/api/sources', { headers: adminHeaders })).status, 200);
    assert.equal((await request('/api/auth/me', { headers: { Authorization: `Bearer ${admin.body.token}` } })).status, 200);
    const viewer = await request('/api/auth/users', { ...post({ username: 'Viewer', password: 'password123', role: 'viewer' }), headers: adminHeaders });
    assert.equal(viewer.status, 201);
    const login = await request('/api/auth/login', post({ username: 'Viewer', password: 'password123' }));
    const viewerCookie = login.cookie.split(';')[0];
    const viewerHeaders = { Cookie: viewerCookie };
    assert.equal((await request('/api/auth/me', { headers: viewerHeaders })).body.role, 'viewer');
    for (const [route, method] of [['/api/settings', 'PUT'], ['/api/sources', 'POST'], ['/api/channels/hide', 'POST'], ['/api/auth/users', 'GET']]) {
        assert.equal((await request(route, { method, headers: viewerHeaders, body: method === 'GET' ? undefined : '{}' })).status, 403, route);
    }
    assert.equal((await request('/api/settings', { headers: viewerHeaders })).status, 200);
    assert.equal((await request('/api/remux?url=file:///etc/passwd', { headers: viewerHeaders })).status, 400);
    assert.equal((await request('/api/probe?url=file:///etc/passwd', { headers: viewerHeaders })).status, 400);
    assert.equal((await request('/api/transcode', { headers: viewerHeaders })).status, 400);
    for (const route of ['/api/transcode?url=file:///etc/passwd', '/api/proxy/image?url=http://169.254.169.254/a',
        '/api/subtitle?url=file:///etc/passwd&index=0']) assert.equal((await request(route, { headers: viewerHeaders })).status, 400, route);
    assert.equal((await request('/api/auth/session', { method: 'POST', headers: { Authorization: `Bearer ${login.body.token}` } })).status, 200);
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: viewerHeaders })).status, 200);
    assert.equal((await request('/api/auth/me', { headers: viewerHeaders })).status, 401);
    const secrets = fs.readFileSync(path.join(fixture.dir, 'security.json'), 'utf8');
    await fixture.stop(); await fixture.start();
    assert.equal(fs.readFileSync(path.join(fixture.dir, 'security.json'), 'utf8'), secrets);
    assert.equal((await request('/api/auth/me', { headers: viewerHeaders })).status, 401);
    assert.equal((await request('/api/auth/me', { headers: adminHeaders })).status, 200);
    const secret = JSON.parse(secrets).jwt;
    const invalid = jwt.sign({ id: admin.body.user.id, role: 'admin', kind: 'mfa' }, secret,
        { audience: 'nodecast-tv', expiresIn: '5m', jwtid: 'temporary' });
    assert.equal((await request('/api/auth/me', { headers: { Authorization: `Bearer ${invalid}` } })).status, 401);
    const nextLogin = await request('/api/auth/login', post({ username: 'Viewer', password: 'password123' }));
    assert.equal(nextLogin.status, 200);
    assert.equal((await request(`/api/auth/users/${viewer.body.id}`, { method: 'PUT', body: JSON.stringify({ password: 'changed123' }), headers: adminHeaders })).status, 200);
    assert.equal((await request('/api/auth/me', { headers: { Authorization: `Bearer ${nextLogin.body.token}` } })).status, 401);
});

test('cross-site requests and spoofed forwarded hosts are blocked, and login attempts are bounded', async t => {
    const { request, base } = await serverFixture(t);
    assert.equal((await request('/api/auth/setup', { ...post({ username: 'Admin', password: 'password123' }),
        headers: { Origin: 'https://untrusted.test', 'X-Forwarded-Host': 'untrusted.test' } })).status, 403);
    assert.equal((await request('/api/auth/setup', { ...post({ username: 'Admin', password: 'password123' }), headers: { Origin: base } })).status, 201);
    assert.equal((await request('/api/sources', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await request('/api/auth/login', { ...post({ username: 'Admin', password: 'password123' }), headers: { Origin: 'null' } })).status, 403);
    for (let i = 0; i < 19; i++) assert.equal((await request('/api/auth/login', post({ username: 'Nobody', password: 'wrong' }))).status, 401);
    const limited = await request('/api/auth/login', post({ username: 'Nobody', password: 'wrong' }));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
});

test('separate installations reject each other\'s cookies even when user IDs match', async t => {
    const first = await serverFixture(t), second = await serverFixture(t);
    const one = await first.request('/api/auth/setup', post({ username: 'Admin', password: 'password123' }));
    const two = await second.request('/api/auth/setup', post({ username: 'Admin', password: 'password123' }));
    assert.equal(one.body.user.id, two.body.user.id);
    assert.notEqual(one.cookie.split('=')[0], two.cookie.split('=')[0]);
    assert.equal((await second.request('/api/auth/me', { headers: { Cookie: one.cookie.split(';')[0] } })).status, 401);
    assert.equal((await first.request('/api/auth/me', { headers: { Cookie: two.cookie.split(';')[0] } })).status, 401);
});
