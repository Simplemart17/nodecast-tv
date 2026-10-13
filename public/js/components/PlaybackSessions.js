(function (root) {
    const cancelled = () => Object.assign(new Error('Playback was superseded'), { name: 'AbortError' });
    class PlaybackSessions {
        constructor(isLive) {
            this.isLive = isLive;
            this.leaseId = null;
            this.sequence = 0;
            this.controller = null;
            this.timer = null;
            root.addEventListener?.('pagehide', () => this.stop());
        }
        async create(url, options) {
            this.leaseId ||= root.crypto.randomUUID?.() || Array.from(root.crypto.getRandomValues(new Uint8Array(16)),
                byte => byte.toString(16).padStart(2, '0')).join('');
            const leaseId = this.leaseId, sequence = ++this.sequence;
            this.controller?.abort();
            const controller = this.controller = new AbortController();
            const response = await fetch('/api/transcode/session', {
                method: 'POST', credentials: 'same-origin', signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...options, url, isLive: this.isLive, playbackLeaseId: leaseId, requestSequence: sequence })
            });
            const session = await response.json();
            if (controller.signal.aborted || leaseId !== this.leaseId || sequence !== this.sequence) {
                if (session.sessionId) fetch(`/api/transcode/${session.sessionId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
                throw cancelled();
            }
            if (!response.ok) throw new Error(session.error || 'Unable to start playback');
            this.timer ||= setInterval(() => {
                if (this.leaseId) fetch('/api/transcode/lease/heartbeat', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ playbackLeaseId: this.leaseId })
                }).catch(() => {});
            }, 30000);
            return session;
        }
        stop() {
            const leaseId = this.leaseId;
            this.leaseId = null;
            this.sequence++;
            this.controller?.abort();
            this.controller = null;
            clearInterval(this.timer);
            this.timer = null;
            if (leaseId) fetch('/api/transcode/lease', {
                method: 'DELETE', keepalive: true, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playbackLeaseId: leaseId })
            }).catch(() => {});
        }
    }
    root.PlaybackSessions = PlaybackSessions;
}(typeof window === 'object' ? window : globalThis));
