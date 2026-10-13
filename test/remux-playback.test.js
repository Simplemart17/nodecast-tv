const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('probe preserves every audio track index including unknown codecs', () => {
    const filename = path.join(__dirname, '..', 'server/routes/probe.js');
    const context = vm.createContext({ require: createRequire(filename), module: { exports: {} }, console });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const info = context.analyzeProbeResult({ streams: [
        { codec_type: 'video', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'mp3' },
        { codec_type: 'subtitle', codec_name: 'srt' },
        { codec_type: 'audio' }, { codec_type: 'audio', codec_name: 'AAC' }
    ], format: { format_name: 'mpegts' } }, 'http://provider.test/media.ts');
    assert.deepEqual(Array.from(info.audioCodecs), ['mp3', 'unknown', 'aac']);
    assert.equal(info.needsRemux, true);
});

function playerFixture(name, settings, probe) {
    const window = { dispatchEvent() {} };
    const context = { window, VodDuration: require('../public/js/components/VodDuration'), console: { log() {}, warn() {}, error() {} },
        CustomEvent: class {}, document: { getElementById() { return null; } },
        API: { settings: { get: async () => settings } }, fetch: probe };
    const file = name === 'VideoPlayer' ? 'components/VideoPlayer.js' : 'pages/WatchPage.js';
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public/js', file), 'utf8'), context);
    const player = Object.create(window[name].prototype);
    const element = { classList: { add() {}, remove() {} } };
    Object.assign(player, { settings, video: { src: '', play: async () => {}, querySelectorAll: () => [] },
        overlay: element, nowPlaying: element,
        stop() { this.playbackGeneration = (this.playbackGeneration || 0) + 1; this.video.src = ''; },
        updateTranscodeStatus() {}, updateQualityBadge() {}, updateNowPlaying() {},
        showNowPlayingOverlay() {}, fetchEpgData() {}, setVolumeFromStorage() {}, showLoading() {},
        showError(message) { throw new Error(message); }
    });
    player.start = url => name === 'VideoPlayer' ? player.play({ id: url }, url) : player.loadVideo(url);
    return player;
}

for (const name of ['VideoPlayer', 'WatchPage']) {
    for (const mode of ['autoTranscode', 'forceRemux']) {
        test(`${name} ${mode} propagates mixed audio codecs to the remux request`, async () => {
            const requests = [];
            const player = playerFixture(name, { [mode]: true }, async url => {
                requests.push(url);
                return { json: async () => ({ audio: 'mp3', audioCodecs: ['mp3', 'aac'], needsRemux: true }) };
            });
            const url = 'http://provider.test/media.ts?password=abc/';
            await player.start(url);
            const remux = new URL(player.video.src, 'http://app.test');
            assert.equal(remux.pathname, '/api/remux');
            assert.equal(remux.searchParams.get('url'), url);
            assert.equal(remux.searchParams.get('audioCodecs'), 'mp3,aac');
            assert.equal(requests.length, 1);
        });
    }
    test(`${name} ignores a remux probe that completes after playback stops`, async () => {
        let complete, started;
        const probing = new Promise(resolve => { started = resolve; });
        const player = playerFixture(name, { forceRemux: true }, () => {
            started();
            return new Promise(resolve => { complete = resolve; });
        });
        const playing = player.start('http://provider.test/media.ts');
        await probing;
        player.stop();
        complete({ json: async () => ({ audioCodecs: ['aac'] }) });
        await playing;
        assert.equal(player.video.src, '');
    });
    test(`${name} ignores a failed automatic probe after playback stops`, async () => {
        let fail, started;
        const probing = new Promise(resolve => { started = resolve; });
        const player = playerFixture(name, { autoTranscode: true }, () => {
            started();
            return new Promise((resolve, reject) => { fail = reject; });
        });
        const playing = player.start('http://provider.test/movie.mp4');
        await probing;
        player.stop();
        fail(new Error('Provider unavailable'));
        await playing;
        assert.equal(player.video.src, '');
    });
}
