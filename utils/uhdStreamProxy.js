const crypto = require('crypto');

const SECRET = process.env.STREAM_PROXY_SECRET || process.env.UHDMOVIES_STREAM_PROXY_SECRET || 'nuvio-uhdmovies-stream-proxy';

function base64UrlEncode(value) {
    return Buffer.from(value, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
}

function sign(value) {
    return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function createUhdProxyToken(payload) {
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    return `${encodedPayload}.${sign(encodedPayload)}`;
}

function decodeUhdProxyToken(token) {
    const [encodedPayload, signature] = String(token || '').split('.');
    if (!encodedPayload || !signature) {
        throw new Error('Invalid proxy token');
    }

    const expectedSignature = sign(encodedPayload);
    const provided = Buffer.from(signature);
    const expected = Buffer.from(expectedSignature);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        throw new Error('Invalid proxy signature');
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const parsedUrl = new URL(payload.driveleechRedirectUrl);
    const allowedHosts = [
        'driveleech.net',
        'www.driveleech.net',
        'driveseed.org',
        'www.driveseed.org',
        'uhdmovies.mov',
        'www.uhdmovies.mov'
    ];

    if (!/^https?:$/.test(parsedUrl.protocol) || !allowedHosts.includes(parsedUrl.hostname)) {
        throw new Error('Unsupported UHDMovies playback URL');
    }

    if (payload.resolvedPlaybackUrl) {
        const resolvedUrl = new URL(payload.resolvedPlaybackUrl);
        const resolvedHost = resolvedUrl.hostname;
        const allowedResolvedHost = [
            ...allowedHosts,
            'cdn.video-leech.pro',
            'cdn.video-gen.xyz',
            'instant.video-gen.xyz',
            'video-downloads.googleusercontent.com'
        ].includes(resolvedHost) ||
            resolvedHost.endsWith('.googleusercontent.com') ||
            resolvedHost.endsWith('.workers.dev') ||
            resolvedHost.endsWith('.r2.dev');

        if (!/^https?:$/.test(resolvedUrl.protocol) || !allowedResolvedHost) {
            throw new Error('Unsupported UHDMovies resolved playback URL');
        }
    }

    return payload;
}

function createUhdPlaybackPath(payload) {
    return `/proxy/uhdmovies/${createUhdProxyToken(payload)}`;
}

function createUhdPlaybackUrl(baseUrl, payload) {
    if (!baseUrl) return null;
    return `${String(baseUrl).replace(/\/+$/g, '')}${createUhdPlaybackPath(payload)}`;
}

module.exports = {
    createUhdPlaybackPath,
    createUhdPlaybackUrl,
    decodeUhdProxyToken
};
