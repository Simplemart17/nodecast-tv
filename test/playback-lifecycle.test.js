const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const express = require('express');

function serviceFixture(t, overrides = {}, nativeSpawn = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-lifecycle-test-'));
    t.after(async () => {
        for (const session of module.exports.getAllSessions()) await module.exports.removeSession(session.id);
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const filename = path.join(__dirname, '../server/services/transcodeSession.js');
    const module = { exports: {} }, realRequire = createRequire(filename), children = [], restarts = [];
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module,
        process: { cwd: () => dir, env: {} }, console: { log() {}, error() {} },
        setTimeout(callback, delay) {
            if (delay === 1000) { const timer = { callback, unref() {} }; restarts.push(timer); return timer; }
            return setTimeout(callback, delay);
        }, clearTimeout(timer) {
            if (timer?.callback) { const index = restarts.indexOf(timer); if (index >= 0) restarts.splice(index, 1); }
            else clearTimeout(timer);
        }, setInterval, clearInterval,
        require(id) {
            if (id === 'child_process' && !nativeSpawn) return { spawn(binary, args) {
                const child = new EventEmitter();
                child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
                child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('close', null)); };
                child.args = args;
                children.push(child);
                return child;
            } };
            if (id === 'fs') return { promises: { ...fs.promises, ...overrides } };
            return realRequire(id);
        }
    }, { filename });
    return { service: module.exports, children, restarts, dir };
}

test('leases replace sessions atomically, reject stale requests and keep accounts separate', async t => {
    const { service } = serviceFixture(t);
    const options = { ownerId: 1, playbackLeaseId: 'opaque_playback_lease_1' };
    const [first, latest] = await Promise.all([1, 2].map(requestSequence => service.createSession('http://provider.test/live', { ...options, requestSequence })));
    assert.equal(first.retired, true);
    assert.equal(service.getSession(first.id, 1), undefined);
    assert.equal(service.getSession(latest.id, 1), latest);
    await assert.rejects(service.createSession('http://provider.test/live', { ...options, requestSequence: 1 }), /superseded/);
    const other = await service.createSession('http://provider.test/live', { ...options, ownerId: 2 });
    await service.releasePlaybackLease(1, options.playbackLeaseId);
    assert.equal(latest.retired, true);
    assert.equal(service.getSession(other.id, 2), other);
    await assert.rejects(service.createSession('http://provider.test/live', { ...options, requestSequence: 100 }), /superseded/);
    await service.releasePlaybackLease(1, 'released_before_arrival');
    await assert.rejects(service.createSession('http://provider.test/live', { ownerId: 1, playbackLeaseId: 'released_before_arrival' }), /superseded/);
    assert.equal(service.refreshPlaybackLease(1, options.playbackLeaseId), false);
    other.lastHeartbeat = Date.now() - 151000;
    await service.cleanupStaleSessions();
    assert.equal(other.retired, true);
    await assert.rejects(service.createSession('http://provider.test/live', { ...options, ownerId: 2, requestSequence: 2 }), /superseded/);
});

test('disconnecting during session startup releases the created session', async t => {
    const filename = path.join(__dirname, '../server/routes/transcode.js');
    const module = { exports: {} }, realRequire = createRequire(filename);
    let ready, starting;
    const waiting = new Promise(resolve => { starting = resolve; });
    const gate = new Promise(resolve => { ready = resolve; });
    const removed = [];
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console: { error() {} }, require(id) {
        if (id === '../db') return { settings: { get: async () => ({}) }, getUserAgent: () => 'test' };
        if (id === '../auth') return { requireAdmin: (req, res, next) => next() };
        if (id === '../services/transcodeSession') return { startCleanupInterval() {},
            async createSession() { return { id: 'owned-session', start: async () => {}, waitForPlaylist() { starting(); return gate; } }; },
            async removeSession(id, owner) { removed.push({ id, owner }); }
        };
        return realRequire(id);
    } }, { filename });
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.user = { id: 7 }; next(); });
    app.use('/api/transcode', module.exports);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${server.address().port}/api/transcode/session`, {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://provider.test/live' })
    });
    const rejected = assert.rejects(response, { name: 'AbortError' });
    await waiting;
    controller.abort();
    await rejected;
    for (let i = 0; i < 100 && !removed.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(removed[0], { id: 'owned-session', owner: 7 });
    ready(false);
});

function ffmpegBinary() {
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
    try { const binary = require('ffmpeg-static'); if (binary && fs.existsSync(binary)) return binary; } catch {}
    return null;
}
const ffmpeg = ffmpegBinary();
test('real FFmpeg creates playable HLS segments and cleans its session cache', { skip: ffmpeg ? false : 'FFmpeg unavailable' }, async t => {
    process.env.ALLOW_LOCAL_MEDIA_URLS = 'true'; // Synthetic loopback media origin only.
    const { service, dir } = serviceFixture(t, {}, true);
    const sample = path.join(dir, 'sample.ts');
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
        '-t', '12', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '20', '-c:a', 'aac', '-f', 'mpegts', sample], { encoding: 'utf8', timeout: 15000 });
    assert.equal(generated.status, 0, generated.stderr);
    const bytes = fs.readFileSync(sample);
    const server = http.createServer((req, res) => { res.setHeader('Content-Length', bytes.length); res.end(bytes); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const session = await service.createSession(`http://127.0.0.1:${server.address().port}/sample.ts`,
        { ownerId: 1, ffmpegPath: ffmpeg, videoMode: 'copy', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 });
    t.after(() => service.removeSession(session.id, 1));
    await session.start();
    assert.equal(await session.waitForPlaylist(5000), true, session.error || 'No playlist generated');
    const playlist = await session.getPlaylist();
    const segment = playlist.split(/\r?\n/).find(line => /^seg\d+\.ts$/.test(line));
    assert.ok(segment, playlist);
    const segmentPath = await session.getSegment(segment);
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', segmentPath, '-f', 'null', '-'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(decoded.status, 0, decoded.stderr);
    assert.equal(await session.getSegment('../session.json'), null);
    await service.removeSession(session.id, 1);
    assert.equal(fs.existsSync(session.dir), false);
});

test('concurrent session creation respects account limits without poisoning the manager', async t => {
    const { service } = serviceFixture(t);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => service.createSession('http://provider.test/live', { ownerId: 1 })));
    const accepted = attempts.filter(result => result.status === 'fulfilled');
    assert.equal(accepted.length, 4);
    assert.ok(attempts.filter(result => result.status === 'rejected').every(result => result.reason.statusCode === 429));
    for (const result of accepted) await service.removeSession(result.value.id, 1);
    const recovered = await service.createSession('http://provider.test/live', { ownerId: 1 });
    await service.removeSession(recovered.id, 1);
});

test('retiring a session during asynchronous startup never spawns FFmpeg or leaves cache files', async t => {
    let release, entered;
    const blocked = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const { service, children } = serviceFixture(t, { async mkdir(dir, options) {
        if (/transcode-cache[/\\][0-9a-f]+$/.test(dir)) { entered(); await gate; }
        return fs.promises.mkdir(dir, options);
    } });
    const session = await service.createSession('http://provider.test/live', { ownerId: 1 });
    const starting = assert.rejects(session.start(), /retired/);
    await blocked;
    const removing = service.removeSession(session.id, 1);
    release();
    await Promise.all([starting, removing]);
    assert.equal(children.length, 0);
    assert.equal(fs.existsSync(session.dir), false);
});

test('cleanup waits for process close and live retries are bounded and cancellable', async t => {
    const { service, children, restarts } = serviceFixture(t);
    const session = await service.createSession('http://provider.test/live', { ownerId: 1, isLive: true });
    await session.start();
    assert.ok(children[0].args.includes('independent_segments+append_list+delete_segments+omit_endlist'));
    for (let i = 0; i < 3; i++) {
        children.at(-1).emit('close', 0);
        assert.equal(session.status, 'reconnecting');
        await restarts.shift().callback();
        await session.startTask;
    }
    assert.equal(children.length, 4);
    children.at(-1).emit('close', 1);
    assert.equal(session.status, 'error');
    assert.equal(restarts.length, 0);
    await service.removeSession(session.id, 1);
    const active = await service.createSession('http://provider.test/live', { ownerId: 1, isLive: true });
    await active.start();
    const child = children.at(-1);
    await service.removeSession(active.id, 1);
    assert.equal(child.killed, 'SIGTERM');
    assert.equal(active.process, null);
    assert.equal(fs.existsSync(active.dir), false);
    assert.equal(restarts.length, 0);
    await assert.rejects(active.start(), /retired/);
});

test('a subprocess spawn error becomes a failed session without an unhandled error event', async t => {
    const { service, children } = serviceFixture(t);
    const session = await service.createSession('http://provider.test/live', { ownerId: 1 });
    await session.start();
    children[0].emit('error', new Error('FFmpeg unavailable'));
    children[0].emit('close', -1);
    assert.equal(await session.waitForPlaylist(10), false);
    assert.equal(session.status, 'error');
    await service.removeSession(session.id, 1);
});

test('browser release and replacement discard late session responses, including insecure HTTP UUID fallback', async () => {
    const requests = [], pending = [], intervals = new Set();
    const window = { crypto: { getRandomValues: values => crypto.webcrypto.getRandomValues(values) }, addEventListener() {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/components/PlaybackSessions.js'), 'utf8'), {
        window, AbortController, Uint8Array, setInterval: callback => { intervals.add(callback); return callback; }, clearInterval: callback => intervals.delete(callback),
        fetch(url, options) {
            requests.push({ url, options });
            if (url === '/api/transcode/session') return new Promise(resolve => pending.push(resolve));
            return Promise.resolve({ ok: true });
        }
    });
    const playback = new window.PlaybackSessions(true);
    const first = assert.rejects(playback.create('http://provider.test/one', {}), /superseded/);
    const lease = JSON.parse(requests[0].options.body).playbackLeaseId;
    assert.match(lease, /^[0-9a-f]{32}$/);
    const active = playback.create('http://provider.test/two', {});
    pending[1]({ ok: true, json: async () => ({ sessionId: 'new', playlistUrl: '/new.m3u8' }) });
    assert.equal((await active).sessionId, 'new');
    pending[0]({ ok: true, json: async () => ({ sessionId: 'old', playlistUrl: '/old.m3u8' }) });
    await first;
    assert.ok(requests.some(request => request.url === '/api/transcode/old' && request.options.method === 'DELETE'));
    assert.equal(intervals.size, 1);
    const stopped = assert.rejects(playback.create('http://provider.test/three', {}), /superseded/);
    playback.stop();
    pending[2]({ ok: true, json: async () => ({ sessionId: 'late' }) });
    await stopped;
    assert.equal(intervals.size, 0);
    assert.ok(requests.some(request => request.url === '/api/transcode/lease' && JSON.parse(request.options.body).playbackLeaseId === lease));
    assert.ok(requests.some(request => request.url === '/api/transcode/late'));
});

test('Watch resume and session seeking preserve original content time and total duration', async () => {
    const window = {}, calls = [];
    const PlaybackSessions = class { async create(url, options) { calls.push({ url, options }); return { sessionId: 'owned', playlistUrl: '/owned.m3u8' }; } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8'), {
        window, PlaybackSessions, VodDuration: require('../public/js/components/VodDuration')
    });
    const watch = Object.create(window.WatchPage.prototype);
    Object.assign(watch, { playbackGeneration: 1, resumeTime: 120, sourceDuration: 600, currentUrl: 'http://provider.test/movie',
        video: { currentTime: 3, duration: 24, pause() {} }, showLoading() {}, playHls(url) { this.playlist = url; } });
    await watch.startTranscodeSession(watch.currentUrl, { videoMode: 'copy' });
    assert.equal(watch.resumeTime, 0);
    assert.equal(watch.getCurrentPlaybackTime(), 123);
    assert.equal(watch.getPlaybackDuration(), 600);
    await watch.seek(50);
    assert.equal(calls[1].options.seekOffset, 300);
    assert.equal(calls[1].url, watch.currentUrl);
    assert.equal(watch.getCurrentPlaybackTime(), 300);
    watch.video.currentTime = 0;
    watch.onMetadataLoaded();
    assert.equal(watch.getCurrentPlaybackTime(), 300);
    assert.equal(watch.playlist, '/owned.m3u8');
});

for (const name of ['VideoPlayer', 'WatchPage']) {
    test(`${name} ignores callbacks from an obsolete HLS instance`, () => {
        const window = {};
        class Hls extends EventEmitter {
            static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error', SUBTITLE_TRACKS_UPDATED: 'subtitles', SUBTITLE_TRACK_SWITCH: 'switch' };
            static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
            loadSource() {} attachMedia() {} destroy() { this.destroyed = true; }
        }
        const file = name === 'VideoPlayer' ? 'components/VideoPlayer.js' : 'pages/WatchPage.js';
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), { window, Hls, console: { log() {}, error() {} } });
        const player = Object.create(window[name].prototype);
        let plays = 0;
        player.video = { play: async () => { plays++; } };
        player.playbackGeneration = 1;
        player.playHls('/old');
        const stale = player.hls, onManifest = stale.listeners('manifest')[0], onError = stale.listeners('error')[0];
        player.playbackGeneration++;
        player.playHls('/new');
        const current = player.hls;
        onManifest();
        onError('error', { fatal: true, type: 'network' });
        assert.equal(plays, 0);
        assert.equal(current.destroyed, undefined);
        current.emit('manifest');
        assert.equal(plays, 1);
    });
}
