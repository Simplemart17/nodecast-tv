// Synthetic HTTP fixtures explicitly opt in to loopback media.
process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const express = require('express');

function loadRemuxRouter() {
    const filename = path.join(__dirname, '..', 'server', 'routes', 'remux.js');
    const realRequire = createRequire(filename);
    const calls = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module,
        URL,
        console: { log() {}, error() {} },
        require(id) {
            if (id === '../db') {
                return { settings: { get: async () => ({}) }, getUserAgent: () => 'test-agent' };
            }
            if (id === 'child_process') {
                return { spawn(binary, args) {
                    calls.push({ binary, args });
                    const child = new EventEmitter();
                    child.stdout = { pipe(res) { res.end('test-media'); } };
                    child.stderr = new EventEmitter();
                    child.kill = () => {};
                    return child;
                } };
            }
            return realRequire(id);
        }
    }, { filename });
    return { router: module.exports, calls };
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

function request(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function routeFixture(t) {
    const fixture = loadRemuxRouter();
    const app = express();
    app.use('/api/remux', fixture.router);
    const server = http.createServer(app);
    t.after(() => new Promise(resolve => server.close(resolve)));
    fixture.base = await listen(server);
    return fixture;
}

test('remux rejects unsafe protocols, controls, and structured query values before spawning', async t => {
    const { base, calls } = await routeFixture(t);
    const invalid = [
        'file:///etc/passwd', 'FILE:///etc/passwd', 'concat:one|two',
        'subfile,,start,0,end,4096,,:/etc/passwd', 'data:text/plain,hello',
        'pipe:0', 'crypto:http://provider.test/media.ts', 'async:http://provider.test/media.ts',
        'cache:http://provider.test/media.ts', 'ftp://provider.test/media.ts', '-i',
        'provider.test/media.ts', 'http://provider.test/\r\nfile:///etc/passwd',
        'http://provider.test/\0media.ts', 'http://provider.test/\tmedia.ts',
        'http://provider.test/\x7fmedia.ts'
    ];
    const queries = invalid.map(url => `url=${encodeURIComponent(url)}`);
    queries.push('', 'url=', 'url=http%3A%2F%2Fprovider.test%2Fa&url=http%3A%2F%2Fprovider.test%2Fb',
        'url[value]=http%3A%2F%2Fprovider.test%2Fa');
    for (const query of queries) {
        const result = await request(`${base}/api/remux?${query}`);
        assert.equal(result.status, 400, query);
        assert.ok(JSON.parse(result.body).error);
    }
    assert.equal(calls.length, 0);
});

test('remux accepts HTTP(S), preserves query credentials, and restricts nested protocols', async t => {
    const { base, calls } = await routeFixture(t);
    for (const url of ['http://provider.test/media.ts', 'https://provider.test/media.m3u8',
        'HTTP://provider.test:8080/media.ts?password=abc/']) {
        assert.equal((await request(`${base}/api/remux?url=${encodeURIComponent(url)}`)).status, 200);
        const args = calls.at(-1).args;
        const inputIndex = args.indexOf('-i');
        const whitelistIndex = args.indexOf('-protocol_whitelist');
        assert.ok(whitelistIndex >= 0 && whitelistIndex < inputIndex);
        assert.equal(args[inputIndex + 1], new URL(url).href);
        const whitelist = args[whitelistIndex + 1].split(',');
        for (const protocol of ['http', 'https', 'tcp', 'tls', 'crypto']) {
            assert.ok(whitelist.includes(protocol), protocol);
        }
        for (const protocol of ['file', 'concat', 'subfile', 'pipe', 'data', 'async', 'cache']) {
            assert.ok(!whitelist.includes(protocol), protocol);
        }
    }
});

test('remux filters only AAC output tracks and rejects malformed codec hints', async t => {
    const { base, calls } = await routeFixture(t);
    const url = `${base}/api/remux?url=http%3A%2F%2Fprovider.test%2Fmedia.ts`;
    assert.equal((await request(`${url}&audioCodecs=mp3%2CAAC%2Cunknown%2Caac%2Cac3`)).status, 200);
    const args = calls.at(-1).args;
    assert.equal(args[args.indexOf('-bsf:a:1') + 1], 'aac_adtstoasc');
    assert.equal(args[args.indexOf('-bsf:a:3') + 1], 'aac_adtstoasc');
    assert.equal(args.filter(arg => arg.startsWith('-bsf:a')).length, 2);
    for (const query of ['audioCodecs=aac&audioCodecs=mp3', 'audioCodecs[x]=aac',
        'audioCodecs=aac,,mp3', 'audioCodecs=-i',
        `audioCodecs=${Array(17).fill('aac').join(',')}`]) {
        assert.equal((await request(`${url}&${query}`)).status, 400, query);
    }
    assert.equal(calls.length, 1);
});

function findFFmpeg() {
    // Match server/index.js: prefer system FFmpeg, then the optional binary.
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
    try {
        const binary = require('ffmpeg-static');
        if (binary && fs.existsSync(binary)) return binary;
    } catch { /* Optional dependency may be absent. */ }
    return null;
}

function runFFmpeg(binary, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [], stderr = [];
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
        child.stdout.on('data', data => stdout.push(data));
        child.stderr.on('data', data => stderr.push(data));
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
        });
    });
}

const ffmpeg = findFFmpeg();
test('real FFmpeg remuxes encrypted HLS over HTTP and blocks local HLS segments',
    { skip: ffmpeg ? false : 'FFmpeg unavailable' }, async t => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-remux-test-'));
        t.after(() => {
            assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
            fs.rmSync(dir, { recursive: true, force: true });
        });
        const sample = path.join(dir, 'media.ts');
        const generated = await runFFmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10',
            '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '12',
            '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-c:a', 'libmp3lame', '-f', 'mpegts', sample]);
        assert.equal(generated.code, 0, generated.stderr);
        const mixedSample = path.join(dir, 'mixed.ts');
        const mixedGenerated = await runFFmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
            '-i', sample, '-map', '0:v', '-map', '0:a', '-map', '0:a',
            '-c:v', 'copy', '-c:a:0', 'libmp3lame', '-c:a:1', 'aac', '-f', 'mpegts', mixedSample]);
        assert.equal(mixedGenerated.code, 0, mixedGenerated.stderr);
        const media = fs.readFileSync(sample), key = Buffer.alloc(16, 0x5a), iv = Buffer.alloc(16);
        const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
        const header = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n';
        const resources = {
            '/media.ts': media,
            '/mixed.ts': fs.readFileSync(mixedSample),
            '/key.bin': key,
            '/encrypted.ts': Buffer.concat([cipher.update(media), cipher.final()]),
            '/plain.m3u8': Buffer.from(`${header}#EXTINF:12,\nmedia.ts\n#EXT-X-ENDLIST\n`),
            '/encrypted.m3u8': Buffer.from(`${header}#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString('hex')}\n#EXTINF:12,\nencrypted.ts\n#EXT-X-ENDLIST\n`),
            '/local.m3u8': Buffer.from(`${header}#EXTINF:12,\n${pathToFileURL(sample).href}\n#EXT-X-ENDLIST\n`)
        };
        const server = http.createServer((req, res) => {
            const body = resources[req.url];
            if (!body) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Length': body.length,
                'Content-Type': req.url.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'application/octet-stream' });
            res.end(body);
        });
        t.after(() => new Promise(resolve => server.close(resolve)));
        const base = await listen(server);
        const { base: routeBase, calls } = await routeFixture(t);
        for (const file of ['media.ts', 'mixed.ts', 'plain.m3u8', 'encrypted.m3u8', 'local.m3u8']) {
            const url = `${base}/${file}`;
            const hints = file === 'mixed.ts' ? '&audioCodecs=mp3,aac' : '';
            assert.equal((await request(`${routeBase}/api/remux?url=${encodeURIComponent(url)}${hints}`)).status, 200);
            const result = await runFFmpeg(ffmpeg, calls.at(-1).args);
            assert.equal(result.timedOut, false, file);
            if (file === 'local.m3u8') {
                assert.notEqual(result.code, 0);
                assert.match(result.stderr, /Protocol 'file' not on whitelist/);
                assert.equal(result.stdout.length, 0);
            } else {
                assert.equal(result.code, 0, `${file} (${ffmpeg}, signal=${result.signal}): ${result.stderr}`);
                assert.ok(result.stdout.includes(Buffer.from('ftyp')), `${file}: no MP4 output`);
                assert.ok(result.stdout.includes(Buffer.from('mdat')), `${file}: no media packets`);
                if (file === 'mixed.ts') {
                    const output = path.join(dir, 'mixed.mp4');
                    fs.writeFileSync(output, result.stdout);
                    const decoded = await runFFmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error',
                        '-i', output, '-map', '0:a', '-f', 'null', '-']);
                    assert.equal(decoded.code, 0, decoded.stderr);
                }
            }
        }
    });
