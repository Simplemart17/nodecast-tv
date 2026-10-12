process.env.ALLOW_LOCAL_MEDIA_URLS = 'true'; // Local HTTP origin fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const proxyStream = require('../server/services/proxyStream');

async function server(t, handler) {
    const instance = http.createServer(handler);
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
        instance.close(resolve);
        instance.closeAllConnections();
    }));
    return `http://127.0.0.1:${instance.address().port}`;
}

async function fixture(t, upstreamHandler) {
    const upstream = await server(t, upstreamHandler);
    const app = express(), router = express.Router();
    router.get('/stream', proxyStream);
    app.use('/api/proxy', router);
    const base = await server(t, app);
    return { upstream, base, proxy: route => `${base}/api/proxy/stream?url=${encodeURIComponent(upstream + route)}` };
}

test('binary proxy delivers the first chunk before upstream finishes', async t => {
    let finish;
    const { proxy } = await fixture(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.write('first-media-chunk');
        finish = () => res.end('last-media-chunk');
    });
    const response = await fetch(proxy('/video'), { signal: AbortSignal.timeout(3000) });
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first-media-chunk');
    finish();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'last-media-chunk');
    assert.equal((await reader.read()).done, true);
});

test('proxy forwards ranges and reports when the origin ignores them', async t => {
    const { proxy } = await fixture(t, (req, res) => {
        assert.equal(req.headers.range, 'bytes=2-5');
        if (req.url === '/honored') {
            res.writeHead(206, { 'Content-Length': 4, 'Content-Range': 'bytes 2-5/10', 'Accept-Ranges': 'bytes' });
            res.end('2345');
        } else { res.writeHead(200, { 'Content-Length': 10 }); res.end('0123456789'); }
    });
    const honored = await fetch(proxy('/honored'), { headers: { Range: 'bytes=2-5' } });
    assert.equal(honored.status, 206);
    assert.equal(honored.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await honored.text(), '2345');
    const ignored = await fetch(proxy('/ignored'), { headers: { Range: 'bytes=2-5' } });
    assert.equal(ignored.status, 200);
    assert.equal(ignored.headers.get('accept-ranges'), 'none');
    assert.equal(await ignored.text(), '0123456789');
});

test('HLS rewrite handles split signatures, encryption keys, and the final redirected URL', async t => {
    const { proxy, upstream } = await fixture(t, (req, res) => {
        if (req.url === '/start') { res.writeHead(302, { Location: '/nested/guide.m3u8' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.write('#EXT');
        setImmediate(() => res.end('M3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nsegment.ts\n'));
    });
    const response = await fetch(proxy('/start'));
    const manifest = await response.text();
    assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl; charset=utf-8');
    assert.ok(manifest.includes(`/api/proxy/stream?url=${encodeURIComponent(upstream + '/nested/key.bin')}`));
    assert.ok(manifest.includes(`/api/proxy/stream?url=${encodeURIComponent(upstream + '/nested/segment.ts')}`));
    assert.ok(!manifest.includes('http://localhost'));
});

test('oversized HLS manifests are rejected with a bounded buffer', async t => {
    const { proxy } = await fixture(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n' + '#'.repeat(5 * 1024 * 1024));
    });
    const response = await fetch(proxy('/oversized'));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /size limit/);
});

test('client cancellation closes upstream and upstream disconnects do not crash the process', async t => {
    let upstreamClosed;
    const closed = new Promise(resolve => { upstreamClosed = resolve; });
    const { proxy } = await fixture(t, (req, res) => {
        if (req.url === '/healthy') return res.end('healthy-media');
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.write('first-media-chunk');
        if (req.url === '/disconnect') setTimeout(() => res.destroy(), 25);
        else res.once('close', upstreamClosed);
    });
    const response = await fetch(proxy('/cancel'));
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.race([closed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Upstream not cancelled')), 2000);
        timer.unref();
    })]);
    const broken = await fetch(proxy('/disconnect'));
    await assert.rejects(broken.arrayBuffer());
    assert.equal(await (await fetch(proxy('/healthy'))).text(), 'healthy-media');
});

test('one transient upstream error is retried; malformed query values return 400', async t => {
    let calls = 0;
    const { proxy, base } = await fixture(t, (req, res) => {
        calls++;
        if (calls === 1) { res.writeHead(503); return res.end('retry'); }
        res.end('recovered-media');
    });
    assert.equal(await (await fetch(proxy('/retry'))).text(), 'recovered-media');
    assert.equal(calls, 2);
    for (const query of ['url=file%3A%2F%2F%2Fetc%2Fpasswd', 'url[x]=http%3A%2F%2Fexample.invalid',
        'url=http%3A%2F%2Fexample.invalid&url=http%3A%2F%2Fexample.invalid']) {
        assert.equal((await fetch(`${base}/api/proxy/stream?${query}`)).status, 400);
    }
    assert.equal(calls, 2);
});
