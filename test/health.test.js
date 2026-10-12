const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { checkHealth } = require('../scripts/healthcheck.cjs');

test('readiness fails during startup, shutdown and either database failure without exposing details', async () => {
    let jsonError = false, sqlError = false, shutdown = false;
    const module = { exports: {} }, filename = path.join(__dirname, '../server/services/health.js');
    const app = { locals: { ready: false } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require(id) {
        if (id === '../db') return { async checkHealth() {
            if (jsonError) throw new Error('Sensitive database path');
            if (shutdown) app.locals.ready = false;
        } };
        return { getDb: () => ({ prepare: () => ({ get() { if (sqlError) throw new Error('Sensitive SQL'); } }) }) };
    } });
    for (const scenario of ['startup', 'healthy', 'json', 'sql', 'shutdown']) {
        app.locals.ready = scenario !== 'startup';
        jsonError = scenario === 'json'; sqlError = scenario === 'sql'; shutdown = scenario === 'shutdown';
        const res = { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
            status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
        await module.exports({ app }, res);
        assert.equal(res.code, scenario === 'healthy' ? 200 : 503, scenario);
        assert.equal(JSON.stringify(res.body), JSON.stringify({ status: scenario === 'healthy' ? 'ok' : 'unavailable' }));
        assert.equal(res.headers['Cache-Control'], 'no-store');
    }
});

test('container probe rejects unhealthy status, SPA responses and stalled connections', async t => {
    let mode = 'healthy';
    const server = http.createServer((req, res) => {
        assert.equal(req.url, '/api/health');
        if (mode === 'stall') return;
        if (mode === 'spa') return res.end('<html>Application</html>');
        res.statusCode = mode === 'healthy' ? 200 : 503;
        res.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    for (mode of ['healthy', 'unhealthy', 'spa', 'stall']) {
        assert.equal(await checkHealth(server.address().port, 100), mode === 'healthy', mode);
    }
});
