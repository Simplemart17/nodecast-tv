const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { validateHttpUrl } = require('./urlSecurity');

const MAX_HLS_MANIFEST_BYTES = 5 * 1024 * 1024;

async function* prepend(first, iterator) {
    try {
        yield first;
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
            yield Buffer.from(next.value);
        }
    } finally {
        try { await iterator.return?.(); } catch { /* Upstream may already be aborted. */ }
    }
}

async function collectManifest(first, iterator) {
    const chunks = [];
    let size = 0;
    for await (const chunk of prepend(first, iterator)) {
        size += chunk.length;
        if (size > MAX_HLS_MANIFEST_BYTES) {
            const error = new Error('HLS manifest exceeds the proxy size limit');
            error.statusCode = 502;
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, size).toString('utf8');
}

function rewriteManifest(manifest, sourceUrl, proxyPath) {
    const proxied = value => `${proxyPath}?url=${encodeURIComponent(new URL(value, sourceUrl).href)}`;
    return manifest.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#')) {
            return line.replace(/URI=["']([^"']+)["']/g, (match, value) => {
                try { return `URI="${proxied(value)}"`; } catch { return match; }
            });
        }
        try { return proxied(trimmed); } catch { return line; }
    }).join('\n');
}

// Adapted from NodeCast TV Plus's streaming proxy. Binary media is never
// buffered in full; only manifests are collected, under a fixed size limit.
async function proxyStream(req, res) {
    try { validateHttpUrl(req.query.url); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    let url;
    try {
        const raw = req.query.url;
        if (typeof raw !== 'string' || /[\x00-\x1f\x7f]/.test(raw)) throw new Error();
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        url = parsed.href;
    } catch {
        return res.status(400).json({ error: 'A valid HTTP(S) URL is required' });
    }

    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (res.destroyed) return;
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', abort);
        try {
            const origin = new URL(url).origin;
            const pluto = ['pluto.tv', 'pluto.io', 'plutotv.net', 'service-stitcher'].some(domain => url.includes(domain));
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity',
                Origin: pluto ? 'https://pluto.tv' : origin,
                Referer: pluto ? 'https://pluto.tv/' : `${origin}/`
            };
            const range = req.get('range');
            if (range) headers.Range = range;
            const upstream = await fetch(url, { headers, signal: controller.signal });
            if (upstream.status >= 500 && attempt < 2) {
                await upstream.body?.cancel();
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }
            if (!upstream.ok) return res.status(upstream.status).send(`Failed to fetch stream: ${upstream.statusText}`);

            const type = upstream.headers.get('content-type') || 'application/octet-stream';
            const length = upstream.headers.get('content-length');
            const encoding = upstream.headers.get('content-encoding');
            const contentRange = upstream.headers.get('content-range');
            const accepts = upstream.headers.get('accept-ranges');
            res.set('Access-Control-Allow-Origin', '*');
            res.status(upstream.status);
            if (length && (!encoding || encoding === 'identity')) res.set('Content-Length', length);
            if (contentRange) res.set('Content-Range', contentRange);
            if (range && !(upstream.status === 206 && contentRange)) res.set('Accept-Ranges', 'none');
            else if (accepts) res.set('Accept-Ranges', accepts);

            if (!upstream.body) return res.end();
            const iterator = upstream.body[Symbol.asyncIterator]();
            const prefix = [];
            let size = 0;
            // The HLS signature can be split across network chunks.
            while (size < 7) {
                const next = await iterator.next();
                if (next.done) break;
                const chunk = Buffer.from(next.value);
                prefix.push(chunk);
                size += chunk.length;
            }
            const first = Buffer.concat(prefix, size);
            const isManifest = first.subarray(0, 7).toString() === '#EXTM3U'
                || /(?:mpegurl|m3u8)/i.test(type);
            if (isManifest) {
                const manifest = await collectManifest(first, iterator);
                res.removeHeader('Content-Length');
                res.removeHeader('Content-Range');
                res.set('Content-Type', 'application/vnd.apple.mpegurl');
                return res.send(rewriteManifest(manifest, upstream.url || url, `${req.baseUrl}/stream`));
            }
            res.set('Content-Type', type);
            await pipeline(Readable.from(prepend(first, iterator), { objectMode: false }), res);
            return;
        } catch (error) {
            if (res.destroyed || controller.signal.aborted) return;
            lastError = error;
            if (res.headersSent) { res.destroy(error); return; }
            res.removeHeader('Content-Length');
            res.removeHeader('Content-Range');
            if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
        } finally {
            res.off('close', abort);
            controller.abort();
        }
    }
    if (!res.headersSent && !res.destroyed) res.status(502).json({ error: lastError?.message || 'Stream proxy failed' });
}

module.exports = proxyStream;
