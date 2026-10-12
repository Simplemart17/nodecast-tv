const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('session lookup, removal and URL helper cannot reuse another account\'s session', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-session-test-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const filename = path.join(__dirname, '../server/services/transcodeSession.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: createRequire(filename),
        process: { cwd: () => dir, env: {} }, console: { log() {}, error() {} }, setTimeout, clearTimeout,
        setInterval, clearInterval }, { filename });
    const service = module.exports;
    const one = await service.createSession('http://provider.test/movie', { ownerId: 1, videoMode: 'copy' });
    one.status = 'running';
    assert.equal(service.getSession(one.id, 2), null);
    assert.equal(await service.removeSession(one.id, 2), false);
    assert.equal(service.getSession(one.id, 1), one);
    const two = await service.getOrCreateSession('http://provider.test/movie', { ownerId: 2, videoMode: 'encode' });
    assert.notEqual(two.id, one.id);
    const changed = await service.getOrCreateSession('http://provider.test/movie', { ownerId: 1, seekOffset: 100 });
    assert.notEqual(changed.id, one.id);
    for (const session of [one, two, changed]) assert.equal(await service.removeSession(session.id, session.ownerId), true);
    assert.equal(service.getAllSessions().length, 0);
});
