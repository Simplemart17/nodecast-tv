// Preserve audio stream order: -map 0:a maps every input audio track.
function parseAudioCodecs(value) {
    if (value === undefined || value === '') return [];
    if (typeof value !== 'string') throw new Error('audioCodecs must be a comma-separated string');
    const codecs = value.split(',').map(codec => codec.trim().toLowerCase());
    if (codecs.length > 16 || codecs.some(codec => !/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(codec))) {
        throw new Error('audioCodecs contains invalid codec names');
    }
    return codecs;
}

function audioFilterArgs(codecs) {
    return codecs.flatMap((codec, index) => codec === 'aac'
        ? [`-bsf:a:${index}`, 'aac_adtstoasc'] : []);
}

module.exports = { parseAudioCodecs, audioFilterArgs };
