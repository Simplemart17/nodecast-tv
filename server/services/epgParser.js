/** Streaming XMLTV parsing with bounded batches and complete-document validation. */
const sax = require('sax');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');
const { parseXmltvDate } = require('./xmltvDate');

async function* parseStreaming(input, batchSize = 1000) {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid EPG batch size');
    const stream = typeof input === 'string' ? Readable.from([input]) : input;
    const parser = sax.parser(true, { trim: true, normalize: true });
    const decoder = new StringDecoder('utf8');
    let channels = [], programmes = [], skippedProgrammes = 0;
    const ready = [];
    let currentObject = null, objectTag = null, textBuffer = '';
    let validTimestamps = true, error = null, depth = 0;
    let sawTvRoot = false, closedTvRoot = false;

    const queueBatch = isLast => {
        ready.push({ channels, programmes, skippedProgrammes, isLast });
        channels = [];
        programmes = [];
        skippedProgrammes = 0;
    };
    parser.onerror = e => {
        error ||= new Error(`Invalid XMLTV document: ${e.message}`);
        parser.resume();
    };
    parser.onopentag = node => {
        if (depth === 0) {
            if (node.name !== 'tv' || sawTvRoot) error ||= new Error('Invalid XMLTV document: expected one <tv> root');
            sawTvRoot = node.name === 'tv';
        }
        depth++;
        const attr = node.attributes;
        if (depth === 2 && node.name === 'channel') {
            objectTag = 'channel';
            currentObject = { id: attr.id, name: null, icon: null, url: null };
        } else if (depth === 2 && node.name === 'programme') {
            objectTag = 'programme';
            const start = parseXmltvDate(attr.start), stop = parseXmltvDate(attr.stop);
            validTimestamps = Boolean(attr.channel && start) && (!attr.stop || Boolean(stop));
            currentObject = { channelId: attr.channel, start, stop, title: null,
                subtitle: null, description: null, category: [], icon: null, date: null, episodeNum: null };
        } else if (node.name === 'icon' && currentObject) {
            currentObject.icon = attr.src;
        }
        textBuffer = '';
    };
    parser.ontext = text => { textBuffer += text; };
    parser.oncdata = parser.ontext;
    parser.onclosetag = tag => {
        if (depth === 1 && tag === 'tv') closedTvRoot = true;
        if (depth === 2 && tag === objectTag) {
            if (objectTag === 'channel' && currentObject.id) {
                currentObject.name ||= currentObject.id;
                channels.push(currentObject);
            } else if (objectTag === 'programme') {
                if (validTimestamps) programmes.push(currentObject);
                else skippedProgrammes++;
            }
            currentObject = null;
            objectTag = null;
            if (programmes.length >= batchSize || channels.length >= batchSize) queueBatch(false);
        } else if (currentObject) {
            switch (tag) {
                case 'display-name': currentObject.name ||= textBuffer; break;
                case 'url': currentObject.url = textBuffer; break;
                case 'title': currentObject.title = textBuffer; break;
                case 'sub-title': currentObject.subtitle = textBuffer; break;
                case 'desc': currentObject.description = textBuffer; break;
                case 'category': if (textBuffer && currentObject.category) currentObject.category.push(textBuffer); break;
                case 'date': currentObject.date = textBuffer; break;
                case 'episode-num': currentObject.episodeNum = textBuffer; break;
            }
        }
        depth--;
    };

    try {
        for await (const chunk of stream) {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            // A network chunk can contain many batches. Keep each one and yield
            // between bounded SAX writes instead of overwriting a pending batch.
            for (let offset = 0; offset < bytes.length; offset += 16384) {
                parser.write(decoder.write(bytes.subarray(offset, offset + 16384)));
                if (error) throw error;
                while (ready.length) yield ready.shift();
            }
        }
        parser.write(decoder.end()).close();
        if (error) throw error;
        if (!sawTvRoot || !closedTvRoot) throw new Error('Invalid XMLTV document: missing complete <tv> root');
        queueBatch(true);
        while (ready.length) yield ready.shift();
    } finally {
        stream.destroy?.();
    }
}

async function parse(input) {
    const channels = [], programmes = [];
    let skippedProgrammes = 0;
    for await (const batch of parseStreaming(input)) {
        channels.push(...batch.channels);
        programmes.push(...batch.programmes);
        skippedProgrammes += batch.skippedProgrammes;
    }
    return { channels, programmes, skippedProgrammes };
}

async function* fetchAndParseStreaming(url, batchSize = 1000) {
    const response = await fetch(url);
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }
    const body = response.body && typeof response.body.pipe === 'function'
        ? response.body : response.body ? Readable.fromWeb(response.body) : Readable.from([]);
    let source, decoded, completion;
    try {
        // Fetch transparently decodes Content-Encoding. Inspect actual bytes
        // so .gz downloads work without double-decompressing HTTP gzip.
        const iterator = body[Symbol.asyncIterator]();
        const prefix = [];
        let prefixLength = 0;
        while (prefixLength < 2) {
            const next = await iterator.next();
            if (next.done) break;
            const chunk = Buffer.from(next.value);
            prefix.push(chunk);
            prefixLength += chunk.length;
        }
        const first = Buffer.concat(prefix);
        source = Readable.from((async function* () {
            if (first.length) yield first;
            for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) yield chunk;
        })(), { objectMode: false });
        decoded = source;
        if (first[0] === 0x1f && first[1] === 0x8b) {
            decoded = zlib.createGunzip();
            completion = pipeline(source, decoded);
            completion.catch(() => {}); // The decoder's async iterator reports failures.
        }
        yield* parseStreaming(decoded, batchSize);
    } finally {
        decoded?.destroy();
        source?.destroy();
        body.destroy();
        if (completion) await completion.catch(() => {});
    }
}

async function fetchAndParse(url) {
    const channels = [], programmes = [];
    let skippedProgrammes = 0;
    for await (const batch of fetchAndParseStreaming(url)) {
        channels.push(...batch.channels);
        programmes.push(...batch.programmes);
        skippedProgrammes += batch.skippedProgrammes;
    }
    return { channels, programmes, skippedProgrammes };
}

function getProgrammesForChannel(programmes, channelId) {
    return programmes.filter(p => p.channelId === channelId);
}

function getCurrentAndUpcoming(programmes, channelId, count = 5) {
    const now = new Date();
    const channelProgrammes = getProgrammesForChannel(programmes, channelId);
    channelProgrammes.sort((a, b) => a.start - b.start);
    return { current: channelProgrammes.find(p => p.start <= now && p.stop > now),
        upcoming: channelProgrammes.filter(p => p.start > now).slice(0, count) };
}

module.exports = { parse, parseXmltvDate, fetchAndParse, fetchAndParseStreaming,
    parseStreaming, getProgrammesForChannel, getCurrentAndUpcoming };
