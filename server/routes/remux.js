const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

/**
 * Remux stream (container conversion only)
 * GET /api/remux?url=...
 * 
 * Remuxes MPEG-TS to fragmented MP4 for browser playback.
 * This is a lightweight operation - no video/audio re-encoding.
 * Use this for raw .ts streams that browsers can't play directly.
 * 
 * Note: This does NOT fix Dolby/AC3 audio issues - use /api/transcode for that.
 */
router.get('/', (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    console.log(`[Remux] Starting remux for: ${url}`);

    // FFmpeg arguments for pure remux (no encoding)
    // Very lightweight - just changes container from TS to fragmented MP4
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        // Low-latency startup: reduce probe/analyze time for faster first bytes
        '-probesize', '32768',
        '-analyzeduration', '500000', // 0.5 seconds - enough to detect audio
        // Error resilience: discard corrupt packets, generate timestamps, ignore DTS, no buffering
        '-fflags', '+genpts+discardcorrupt+igndts+nobuffer',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues with bad timestamps
        '-max_delay', '5000000',
        // Reconnect settings for network drops
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', url,
        // STRICT MAPPING: Only map video and audio, ignore subtitles/data/attachments
        // This prevents remux failure when source container has incompatible subtitle tracks (e.g. MKV -> MP4)
        '-map', '0:v',
        '-map', '0:a',
        // Drop subtitles (-sn) and data (-dn) explicitly
        '-sn', '-dn',
        // Copy streams without re-encoding
        '-c', 'copy',
        // NOTE: We intentionally do NOT use -bsf:a aac_adtstoasc here
        // That filter only works for AAC audio and breaks AC3/EAC3/MP3.
        // If AAC audio from MPEG-TS fails in MP4, use /api/transcode instead.
        // Handle timestamp discontinuities at output
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-' // Output to stdout
    ];

    console.log(`[Remux] Full command: ${ffmpegPath} ${args.join(' ')}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Remux] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Log stderr (useful for debugging)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        // Only log warnings/errors, not progress
        if (msg.includes('Warning') || msg.includes('Error') || msg.includes('error')) {
            console.log(`[Remux FFmpeg] ${msg}`);
        }
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        console.log('[Remux] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) {
            console.error(`[Remux] FFmpeg exited with code ${code}`);
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Remux] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Remux failed to start' });
        }
    });
});

module.exports = router;
