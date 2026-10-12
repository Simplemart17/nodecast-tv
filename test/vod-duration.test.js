const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const VodDuration = require('../public/js/components/VodDuration');

test('VOD duration understands provider fields, clock strings and invalid values', () => {
    for (const [input, expected] of [[5400, 5400], ['5400.5', 5400.5], ['01:30:00', 5400], ['45:30', 2730], ['90:00', 5400]]) {
        assert.equal(VodDuration.parse(input), expected);
    }
    for (const value of [Infinity, NaN, -1, null, {}, '', '1:99:00', '1:2:3:4', 'unknown']) assert.equal(VodDuration.parse(value), 0);
    assert.equal(VodDuration.fromContent({ info: { duration: '01:30:00' } }), 5400);
    assert.equal(VodDuration.fromContent({ duration_secs: 0, duration: '45:30' }), 2730);
});

test('Watch displays provider totals for sessions, browser totals for direct media, and resets between content', () => {
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8'), { window, VodDuration });
    const watch = Object.create(window.WatchPage.prototype);
    let hidden;
    Object.assign(watch, { video: { duration: Infinity }, durationEl: {},
        timeTotal: { classList: { toggle(key, value) { hidden = value; } } } });
    watch.setSourceDuration('01:30:00');
    assert.equal(watch.timeTotal.textContent, '1:30:00');
    assert.equal(watch.durationEl.textContent, '1:30:00');
    assert.equal(hidden, false);
    watch.currentSessionId = 'session';
    watch.video.duration = 24;
    watch.updateDurationDisplay();
    assert.equal(watch.timeTotal.textContent, '1:30:00');
    watch.currentSessionId = null;
    watch.video.duration = 5405;
    watch.setSourceDuration(watch.video.duration);
    assert.equal(watch.timeTotal.textContent, '1:30:05');
    watch.sourceDuration = 0; watch.video.duration = NaN;
    watch.updateDurationDisplay();
    assert.equal(watch.durationEl.textContent, '');
    assert.equal(hidden, true);
    watch.sourceDuration = 5400; watch.currentSessionId = 'old'; watch.video.duration = 24;
    let savedDuration;
    Object.assign(watch, { stopHistoryTracking() {}, saveProgress() { savedDuration = this.getPlaybackDuration(); },
        stopTranscodeSession() { this.currentSessionId = null; }, updateTranscodeStatus() {}, hideNowPlaying() {} });
    watch.timeTotal.classList.add = () => { hidden = true; };
    watch.video.pause = () => {}; watch.video.load = () => {};
    watch.stop();
    assert.equal(savedDuration, 5400);
    assert.equal(watch.timeTotal.textContent, '');
    assert.equal(watch.getPlaybackDuration(), 0);
});
