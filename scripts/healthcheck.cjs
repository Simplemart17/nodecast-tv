const http = require('node:http');

function checkHealth(port = process.env.PORT || 3000, timeout = 4000) {
    return new Promise(resolve => {
        let settled = false;
        const finish = healthy => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(healthy);
        };
        const request = http.get({ host: '127.0.0.1', port, path: '/api/health' }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
                if (body.length > 4096) { finish(false); request.destroy(); }
            });
            response.on('error', () => finish(false));
            response.on('end', () => {
                try { finish(response.statusCode === 200 && JSON.parse(body).status === 'ok'); }
                catch { finish(false); }
            });
        });
        request.on('error', () => finish(false));
        const timer = setTimeout(() => { finish(false); request.destroy(); }, timeout);
    });
}

if (require.main === module) checkHealth().then(healthy => { process.exitCode = healthy ? 0 : 1; });
module.exports = { checkHealth };
