const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

// Run with NODECAST_BROWSER_TESTS=1 after `npx playwright install chromium`.
// An existing Chromium browser can be supplied with NODECAST_BROWSER_EXECUTABLE.
test('both subtitle menus select real HLS cues, discard stale tracks and preserve native captions',
    { skip: process.env.NODECAST_BROWSER_TESTS !== '1' ? 'Browser tests are opt-in locally; enabled in CI' : false,
        timeout: 90000 }, async t => {
        const { chromium } = require('playwright');
        let binary = 'ffmpeg';
        if (spawnSync(binary, ['-version'], { stdio: 'ignore' }).status !== 0) binary = require('ffmpeg-static');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-captions-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const generated = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10', '-t', '8', '-c:v', 'libx264',
            '-threads', '1', '-preset', 'ultrafast', '-g', '10', '-f', 'hls', '-hls_time', '1',
            '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, 'segment%d.ts'), path.join(dir, 'video.m3u8')],
        { encoding: 'utf8', timeout: 15000 });
        assert.equal(generated.status, 0, generated.stderr);

        const root = path.join(__dirname, '../public');
        const scripts = ['/js/components/CaptionTracks.js', '/js/components/VideoPlayer.js', '/js/pages/WatchPage.js'];
        const master = names => '#EXTM3U\n' + names.map(([name, extra, language = 'en'], index) =>
            `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${name}",LANGUAGE="${language}",DEFAULT=NO,AUTOSELECT=NO,${extra}URI="/sub${index}.m3u8"\n`).join('') +
            '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.42c00a",SUBTITLES="subs"\n/video.m3u8\n';
        const requests = [];
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://fixture.test');
            requests.push(url.pathname);
            const send = (type, content) => { res.writeHead(200, { 'Content-Type': type }); res.end(content); };
            if (url.pathname === '/') return send('text/html', `<video muted></video><div id="menu"></div><div id="list"></div><div id="ui"></div><script src="/hls.js"></script>${scripts.map(src => `<script src="${src}"></script>`).join('')}`);
            if (url.pathname === '/hls.js') return send('application/javascript', fs.readFileSync(require.resolve('hls.js/dist/hls.min.js')));
            if (scripts.includes(url.pathname)) return send('application/javascript', fs.readFileSync(path.join(root, url.pathname)));
            if (url.pathname === '/master.m3u8') return send('application/vnd.apple.mpegurl', master([
                ['English', ''], ['English', 'CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound",'],
                ['English', 'FORCED=YES,']
            ]));
            if (url.pathname === '/next.m3u8') return send('application/vnd.apple.mpegurl', master([['French', '', 'fr']]));
            if (url.pathname === '/default.m3u8') return send('application/vnd.apple.mpegurl', master([['English', '']]).replace('DEFAULT=NO', 'DEFAULT=YES'));
            if (url.pathname === '/api/probe') return send('application/json', JSON.stringify({ compatible: true,
                subtitles: [{ index: 2, title: 'English', language: 'en' }] }));
            if (/^\/sub\d.m3u8$/.test(url.pathname)) return send('application/vnd.apple.mpegurl',
                `#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:8,\n${url.pathname.replace('.m3u8', '.vtt')}\n#EXT-X-ENDLIST\n`);
            if (/^\/sub\d.vtt$/.test(url.pathname) || url.pathname === '/api/subtitle') return send('text/vtt',
                `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n\n00:00:00.000 --> 00:00:08.000\nCue from ${url.pathname}\n\n`);
            if (url.pathname === '/video.m3u8' || /^\/segment\d.ts$/.test(url.pathname)) return send(
                url.pathname.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl', fs.readFileSync(path.join(dir, url.pathname)));
            res.writeHead(404); res.end();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
        const browser = await chromium.launch({ headless: true,
            executablePath: process.env.NODECAST_BROWSER_EXECUTABLE || undefined });
        t.after(() => browser.close());
        const base = `http://127.0.0.1:${server.address().port}`;

        for (const name of ['VideoPlayer', 'WatchPage']) {
            requests.length = 0;
            const page = await browser.newPage();
            page.on('pageerror', error => console.error('Browser error:', error.message));
            if (process.env.NODECAST_BROWSER_DEBUG) page.on('console', message => console.log('Browser:', message.text()));
            await page.goto(base);
            await page.evaluate(name => {
                const player = window.player = Object.create(window[name].prototype);
                const ui = document.getElementById('ui');
                Object.assign(player, { video: document.querySelector('video'), captionsList: document.getElementById('list'),
                    captionsMenu: document.getElementById('menu'), overlay: ui, nowPlaying: ui, playbackGeneration: 1,
                    getHlsConfig: () => ({ enableWorker: false, renderTextTracksNatively: false }), stopHistoryTracking() {}, saveProgress() {},
                    hideNowPlaying() {}, updateTranscodeStatus() {}, stopTranscodeSession() {} });
                // Browser-generated tracks survive source changes and cannot be removed.
                player.video.addTextTrack('subtitles', 'English', 'en');
                player.video.addTextTrack('subtitles', 'English', 'en');
                player.stop();
                player.getCaptionTracks().setProbe({ subtitles: [{ index: 2, title: 'English', language: 'en' }] }, 'http://provider.test/live');
                player.playHls('/master.m3u8');
                player.hls.on(Hls.Events.ERROR, (event, data) => console.error('HLS fixture:', data.details, data.error?.message));
            }, name);
            await page.waitForFunction(() => document.querySelectorAll('#list button').length === 4);
            assert.deepEqual(await page.locator('#list button').allTextContents(), ['Off', 'English', 'English (SDH)', 'English (Forced)']);
            assert.equal(await page.locator('video > track[src^="/api/subtitle"]').count(), 0, 'HLS subtitles must not also be extracted');
            for (let index = 0; index < 3; index++) {
                await page.locator('#list button').nth(index + 1).click();
                await page.evaluate(() => { window.player.video.pause(); window.player.video.currentTime = 2; });
                await page.waitForFunction(index => {
                    const video = window.player.video;
                    return window.player.hls.subtitleTrack === index && Array.from(video.textTracks).some(track =>
                        track.mode === 'showing' && Array.from(track.activeCues || []).some(cue => cue.text === `Cue from /sub${index}.vtt`));
                }, index, { timeout: 10000 }).catch(async error => {
                    console.error(requests);
                    console.error(name, index, await page.evaluate(() => ({
                        index: window.player.hls.subtitleTrack, ready: window.player.video.readyState,
                        time: window.player.video.currentTime, duration: window.player.video.duration,
                        options: window.player.hls.subtitleTracks.map(track => ({ name: track.name, lang: track.lang, characteristics: track.characteristics })),
                        tracks: Array.from(window.player.video.textTracks, track => ({ lang: track.language, label: track.label, kind: track.kind,
                            mode: track.mode, cues: Array.from(track.cues || [], cue => ({ text: cue.text, start: cue.startTime, end: cue.endTime })),
                            active: Array.from(track.activeCues || [], cue => cue.text) }))
                    })));
                    throw error;
                });
                assert.equal(await page.locator('#list button.active').count(), 1);
            }
            await page.locator('#list button').first().click();
            assert.equal(await page.evaluate(() => window.player.hls.subtitleTrack), -1);
            assert.equal(await page.evaluate(() => Array.from(window.player.video.textTracks).every(track => track.mode === 'disabled')), true);
            assert.equal(requests.includes('/api/subtitle'), false);

            await page.evaluate(() => { window.player.stop(); window.player.playHls('/next.m3u8'); });
            await page.waitForFunction(() => document.querySelectorAll('#list button').length === 2 && document.querySelectorAll('#list button')[1].textContent === 'French');
            await page.locator('#list button').nth(1).click();
            await page.waitForFunction(() => Array.from(window.player.video.textTracks).some(track => track.language === 'fr' && track.mode === 'showing' && track.cues?.length));

            await page.evaluate(() => {
                const player = window.player;
                const callbacks = [Hls.Events.CUES_PARSED, Hls.Events.SUBTITLE_TRACKS_UPDATED, Hls.Events.NON_NATIVE_TEXT_TRACKS_FOUND]
                    .map(event => player.hls.listeners(event).at(-1));
                player.stop();
                // Late events from an old instance must not recreate tracks or populate the menu.
                for (const callback of callbacks) callback('late', { track: 'subtitles0', cues: [], subtitleTracks: [], tracks: [] });
                player.playHls('/default.m3u8');
            });
            await page.waitForFunction(() => window.player.hls.subtitleTrack === 0 && Array.from(window.player.video.textTracks).some(track => track.mode === 'showing' && track.cues?.length));
            assert.deepEqual(await page.locator('#list button.active').allTextContents(), ['English']);

            if (name === 'VideoPlayer') {
                // Exercise the separate normal Live TV branch, including its automatic probe.
                await page.evaluate(async base => {
                    const player = window.player;
                    Object.assign(player, { settings: { autoTranscode: true }, updateQualityBadge() {}, updateNowPlaying() {},
                        showNowPlayingOverlay() {}, fetchEpgData() {} });
                    await player.play({ id: 'fixture', name: 'Fixture' }, `${base}/master.m3u8`);
                }, base);
                await page.waitForFunction(() => document.querySelectorAll('#list button').length === 4);
                await page.locator('#list button').nth(2).click();
                await page.waitForFunction(() => window.player.hls.subtitleTrack === 1 && Array.from(window.player.video.textTracks).some(track =>
                    track.mode === 'showing' && Array.from(track.cues || []).some(cue => cue.text === 'Cue from /sub1.vtt')));
            }

            await page.evaluate(() => {
                const player = window.player;
                player.stop();
                player.getCaptionTracks().setProbe({ subtitles: [{ index: 4, title: 'Extracted English', language: 'en' }] }, 'http://provider.test/live.ts');
                player.playHls('/video.m3u8');
            });
            await page.waitForFunction(() => document.querySelectorAll('#list button').length === 2 && document.querySelectorAll('#list button')[1].textContent === 'Extracted English');
            await page.locator('#list button').nth(1).click();
            await page.waitForFunction(() => Array.from(window.player.video.textTracks).some(track => track.label === 'Extracted English' && track.mode === 'showing' && track.cues?.length));
            await page.evaluate(() => {
                const hls = window.player.hls;
                hls.trigger(Hls.Events.NON_NATIVE_TEXT_TRACKS_FOUND, { tracks: [{ _id: 'textTrack1', label: 'English CC', kind: 'captions', default: false }] });
                const cue = new VTTCue(0, 8, 'CEA caption');
                hls.trigger(Hls.Events.CUES_PARSED, { type: 'captions', track: 'textTrack1', cues: [cue, cue] });
                window.player.updateCaptionsTracks();
            });
            await page.locator('#list button').nth(2).click();
            await page.waitForFunction(() => {
                const track = Array.from(window.player.video.textTracks).find(track => track.label === 'English CC');
                return track.mode === 'showing' && track.cues?.length === 1 && track.cues[0].text === 'CEA caption';
            });

            await page.evaluate(() => {
                const player = window.player;
                player.stop();
                const metadata = player.video.addTextTrack('metadata', 'Internal metadata');
                metadata.mode = 'hidden';
                player.getCaptionTracks().setProbe({ subtitles: [{ index: 3, title: '<b>English</b>', language: 'en' }] }, 'http://provider.test/video.ts');
                player.getCaptionTracks().useNative();
                const cea = player.video.addTextTrack('captions', 'English CC', 'en');
                cea.addCue(new VTTCue(0, 8, 'Native caption'));
                player.updateCaptionsTracks();
            });
            await page.waitForFunction(() => document.querySelectorAll('#list button').length === 3);
            assert.deepEqual(await page.locator('#list button').allTextContents(), ['Off', '<b>English</b>', 'English CC']);
            assert.equal(await page.locator('#list b').count(), 0, 'Provider labels must be rendered as text');
            await page.locator('#list button').nth(1).click();
            await page.waitForFunction(() => Array.from(window.player.video.textTracks).some(track => track.label === '<b>English</b>' && track.mode === 'showing' && track.cues?.length));
            await page.locator('#list button').nth(2).click();
            assert.equal(await page.evaluate(() => Array.from(window.player.video.textTracks).find(track => track.label === 'English CC').mode), 'showing');
            await page.locator('#list button').first().click();
            assert.equal(await page.evaluate(() => Array.from(window.player.video.textTracks).find(track => track.kind === 'metadata').mode), 'hidden');
            await page.evaluate(() => window.player.stop());
            assert.deepEqual(await page.locator('#list button').allTextContents(), ['Off']);
            assert.equal(await page.locator('video > track').count(), 0);
            await page.close();
        }
    });
