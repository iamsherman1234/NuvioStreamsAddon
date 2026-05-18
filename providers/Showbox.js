require('dotenv').config();
const axios = require('axios');

// TMDB API Configuration (for convertImdbToTmdb helper)
const TMDB_API_KEY = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// API Base URL
const FEBAPI_BASE_URL = 'https://febapi.nuvioapp.space/api/media';
const SHOWBOX_FEBBOX_API_URL = (process.env.SHOWBOX_FEBBOX_API_URL || '').replace(/\/+$/g, '');
const SHOWBOX_FEBBOX_API_ONLY = process.env.SHOWBOX_FEBBOX_API_ONLY === 'true';

/**
 * Parse quality from label string
 */
const parseQualityFromLabel = (label) => {
    if (!label) return "ORG";

    const labelLower = String(label).toLowerCase();

    if (labelLower.includes('1080p') || labelLower.includes('1080')) {
        return "1080p";
    } else if (labelLower.includes('720p') || labelLower.includes('720')) {
        return "720p";
    } else if (labelLower.includes('480p') || labelLower.includes('480')) {
        return "480p";
    } else if (labelLower.includes('360p') || labelLower.includes('360')) {
        return "360p";
    } else if (labelLower.includes('2160p') || labelLower.includes('2160') ||
        labelLower.includes('4k') || labelLower.includes('uhd')) {
        return "2160p";
    } else if (labelLower.includes('hd')) {
        return "720p"; // Assuming HD is 720p
    } else if (labelLower.includes('sd')) {
        return "480p"; // Assuming SD is 480p
    }

    // Use ORG (original) label for unknown quality
    return "ORG";
};

/**
 * Extract codec details from filename/text
 */
const extractCodecDetails = (text) => {
    if (!text || typeof text !== 'string') return [];
    const details = new Set();
    const lowerText = text.toLowerCase();

    // Video Codecs & Technologies
    if (lowerText.includes('dolby vision') || lowerText.includes('dovi') || lowerText.includes('.dv.')) details.add('DV');
    if (lowerText.includes('hdr10+') || lowerText.includes('hdr10plus')) details.add('HDR10+');
    else if (lowerText.includes('hdr')) details.add('HDR'); // General HDR if not HDR10+
    if (lowerText.includes('sdr')) details.add('SDR');

    if (lowerText.includes('av1')) details.add('AV1');
    else if (lowerText.includes('h265') || lowerText.includes('x265') || lowerText.includes('hevc')) details.add('H.265');
    else if (lowerText.includes('h264') || lowerText.includes('x264') || lowerText.includes('avc')) details.add('H.264');

    // Audio Codecs
    if (lowerText.includes('atmos')) details.add('Atmos');
    if (lowerText.includes('truehd') || lowerText.includes('true-hd')) details.add('TrueHD');
    if (lowerText.includes('dts-hd ma') || lowerText.includes('dtshdma') || lowerText.includes('dts-hdhr')) details.add('DTS-HD MA');
    else if (lowerText.includes('dts-hd')) details.add('DTS-HD'); // General DTS-HD if not MA/HR
    else if (lowerText.includes('dts') && !lowerText.includes('dts-hd')) details.add('DTS'); // Plain DTS

    if (lowerText.includes('eac3') || lowerText.includes('e-ac-3') || lowerText.includes('dd+') || lowerText.includes('ddplus')) details.add('EAC3');
    else if (lowerText.includes('ac3') || (lowerText.includes('dd') && !lowerText.includes('dd+') && !lowerText.includes('ddp'))) details.add('AC3'); // Plain AC3/DD

    if (lowerText.includes('aac')) details.add('AAC');
    if (lowerText.includes('opus')) details.add('Opus');
    if (lowerText.includes('mp3')) details.add('MP3');

    // Bit depth (less common but useful)
    if (lowerText.includes('10bit') || lowerText.includes('10-bit')) details.add('10-bit');
    else if (lowerText.includes('8bit') || lowerText.includes('8-bit')) details.add('8-bit');

    return Array.from(details);
};

/**
 * Helper function to parse size string to bytes
 */
const parseSizeToBytes = (sizeString) => {
    if (!sizeString || typeof sizeString !== 'string') return Number.MAX_SAFE_INTEGER;

    const sizeLower = sizeString.toLowerCase();

    if (sizeLower.includes('unknown') || sizeLower.includes('n/a')) {
        return Number.MAX_SAFE_INTEGER; // Sort unknown/NA sizes last
    }

    const units = {
        gb: 1024 * 1024 * 1024,
        mb: 1024 * 1024,
        kb: 1024,
        b: 1
    };

    const match = sizeString.match(/([\d.]+)\s*(gb|mb|kb|b)/i);
    if (match && match[1] && match[2]) {
        const value = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (!isNaN(value) && units[unit]) {
            return Math.floor(value * units[unit]);
        }
    }
    return Number.MAX_SAFE_INTEGER; // Fallback for unparsed strings
};

/**
 * Utility function to sort streams by quality in order of resolution
 */
const sortStreamsByQuality = (streams) => {
    // Since Stremio displays streams from bottom to top,
    // we need to sort in reverse order to what we want to show
    const qualityOrder = {
        "ORG": 1,     // ORG will show at the top (since it's at the bottom of the list)
        "2160p": 2,
        "1080p": 3,
        "720p": 4,
        "480p": 5,
        "360p": 6     // 360p will show at the bottom
    };

    // Provider sort order: lower number means earlier in array (lower in Stremio UI for same quality/size)
    const providerSortKeys = {
        'ShowBox': 1,
        'Xprime.tv': 2,
        'HollyMovieHD': 3,
        'Soaper TV': 4,
        // Default for unknown providers
        default: 99
    };

    return [...streams].sort((a, b) => {
        const qualityA = a.quality || "ORG";
        const qualityB = b.quality || "ORG";

        const orderA = qualityOrder[qualityA] || 10;
        const orderB = qualityOrder[qualityB] || 10;

        // First, compare by quality order
        if (orderA !== orderB) {
            return orderA - orderB;
        }

        // If qualities are the same, compare by size (descending - larger sizes first means earlier in array)
        const sizeAInBytes = parseSizeToBytes(a.size);
        const sizeBInBytes = parseSizeToBytes(b.size);

        if (sizeAInBytes !== sizeBInBytes) {
            return sizeBInBytes - sizeAInBytes;
        }

        // If quality AND size are the same, compare by provider
        const providerA = a.provider || 'default';
        const providerB = b.provider || 'default';

        const providerOrderA = providerSortKeys[providerA] || providerSortKeys.default;
        const providerOrderB = providerSortKeys[providerB] || providerSortKeys.default;

        return providerOrderA - providerOrderB;
    });
};

/**
 * Convert IMDb ID to TMDB ID
 * Used by addon.js for IMDb ID resolution
 */
const convertImdbToTmdb = async (imdbId, regionPreference = null, expectedType = null) => {
    console.time(`convertImdbToTmdb_total_${imdbId}`);
    if (!imdbId || !imdbId.startsWith('tt')) {
        console.log('  Invalid IMDb ID format provided for conversion.', imdbId);
        console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
        return null;
    }
    console.log(`  Attempting to convert IMDb ID: ${imdbId} to TMDB ID${expectedType ? ` (expected type: ${expectedType})` : ''}.`);

    const findApiUrl = `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    console.log(`    Fetching from TMDB find API: ${findApiUrl}`);
    console.time(`convertImdbToTmdb_apiCall_${imdbId}`);

    try {
        const response = await axios.get(findApiUrl, { timeout: 10000 });
        console.timeEnd(`convertImdbToTmdb_apiCall_${imdbId}`);
        const findResults = response.data;

        if (findResults) {
            let result = null;

            // Context-aware prioritization based on expected type
            if (expectedType === 'tv' || expectedType === 'series') {
                // For series requests, prioritize TV results
                if (findResults.tv_results && findResults.tv_results.length > 0) {
                    result = { tmdbId: String(findResults.tv_results[0].id), tmdbType: 'tv', title: findResults.tv_results[0].name || findResults.tv_results[0].original_name };
                    console.log(`    Prioritized TV result for series request: ${result.title}`);
                } else if (findResults.movie_results && findResults.movie_results.length > 0) {
                    result = { tmdbId: String(findResults.movie_results[0].id), tmdbType: 'movie', title: findResults.movie_results[0].title || findResults.movie_results[0].original_title };
                    console.log(`    Fallback to movie result for series request: ${result.title}`);
                }
            } else if (expectedType === 'movie') {
                // For movie requests, prioritize movie results
                if (findResults.movie_results && findResults.movie_results.length > 0) {
                    result = { tmdbId: String(findResults.movie_results[0].id), tmdbType: 'movie', title: findResults.movie_results[0].title || findResults.movie_results[0].original_title };
                    console.log(`    Prioritized movie result for movie request: ${result.title}`);
                } else if (findResults.tv_results && findResults.tv_results.length > 0) {
                    result = { tmdbId: String(findResults.tv_results[0].id), tmdbType: 'tv', title: findResults.tv_results[0].name || findResults.tv_results[0].original_name };
                    console.log(`    Fallback to TV result for movie request: ${result.title}`);
                }
            } else {
                // Default behavior: prioritize movie results, then tv results (backward compatibility)
                if (findResults.movie_results && findResults.movie_results.length > 0) {
                    result = { tmdbId: String(findResults.movie_results[0].id), tmdbType: 'movie', title: findResults.movie_results[0].title || findResults.movie_results[0].original_title };
                } else if (findResults.tv_results && findResults.tv_results.length > 0) {
                    result = { tmdbId: String(findResults.tv_results[0].id), tmdbType: 'tv', title: findResults.tv_results[0].name || findResults.tv_results[0].original_name };
                }
            }

            if (findResults.person_results && findResults.person_results.length > 0 && !result) {
                // Could handle other types if necessary, e.g. person, but for streams, movie/tv are key
                console.log(`    IMDb ID ${imdbId} resolved to a person, not a movie or TV show on TMDB.`);
            } else if (!result) {
                console.log(`    No movie or TV results found on TMDB for IMDb ID ${imdbId}. Response:`, JSON.stringify(findResults).substring(0, 200));
            }

            if (result && result.tmdbId && result.tmdbType) {
                console.log(`    Successfully converted IMDb ID ${imdbId} to TMDB ${result.tmdbType} ID ${result.tmdbId} (${result.title})`);
                console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
                return result;
            } else {
                console.log(`    Could not convert IMDb ID ${imdbId} to a usable TMDB movie/tv ID.`);
            }
        }
    } catch (error) {
        if (console.timeEnd && typeof console.timeEnd === 'function') console.timeEnd(`convertImdbToTmdb_apiCall_${imdbId}`); // Ensure timer ends on error
        const errorMessage = error.response ? `${error.message} (Status: ${error.response.status})` : error.message;
        console.log(`    Error during TMDB find API call for IMDb ID ${imdbId}: ${errorMessage}`);
    }
    console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
    return null;
};

/**
 * Check quota for a cookie and return remaining MB
 * Returns { ok: boolean, remainingMB: number, cookie: string }
 */
const checkCookieQuota = async (cookie) => {
    try {
        const headers = {
            'Cookie': cookie.startsWith('ui=') ? cookie : `ui=${cookie}`,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
        const resp = await axios.get('https://www.febbox.com/console/user_cards', {
            headers,
            timeout: 8000,
            validateStatus: () => true
        });
        if (resp.status === 200 && resp.data && resp.data.data && resp.data.data.flow) {
            const flow = resp.data.data.flow;
            const remaining = (Number(flow.traffic_limit_mb) || 0) - (Number(flow.traffic_usage_mb) || 0);
            return { ok: true, remainingMB: remaining, cookie };
        }
    } catch (e) {
        console.log(`[ShowBox] Quota check failed for cookie: ${e.message}`);
    }
    // Return ok: false but still include the cookie so we can use it as fallback
    return { ok: false, remainingMB: -1, cookie };
};

const getTmdbMediaDetails = async (tmdbType, tmdbId) => {
    try {
        const endpoint = tmdbType === 'tv' || tmdbType === 'series' ? 'tv' : 'movie';
        const response = await axios.get(`${TMDB_BASE_URL}/${endpoint}/${tmdbId}`, {
            params: { api_key: TMDB_API_KEY, language: 'en-US' },
            timeout: 10000
        });
        const data = response.data || {};
        return {
            title: endpoint === 'tv' ? (data.name || data.original_name) : (data.title || data.original_title),
            year: String((endpoint === 'tv' ? data.first_air_date : data.release_date) || '').slice(0, 4),
            type: endpoint
        };
    } catch (error) {
        console.warn(`[ShowBox Fallback] Failed to fetch TMDB details for ${tmdbType}/${tmdbId}: ${error.message}`);
        return null;
    }
};

const normalizeTitle = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const selectBestShowboxSearchResult = (results, mediaInfo) => {
    if (!Array.isArray(results) || results.length === 0) return null;
    const targetTitle = normalizeTitle(mediaInfo?.title);
    const targetYear = String(mediaInfo?.year || '');

    const scored = results.map(item => {
        const title = normalizeTitle(item.title || item.name || item.original_title || item.original_name);
        const year = String(item.year || item.release_year || item.releaseDate || item.release_date || item.first_air_date || '');
        let score = 0;
        if (title && targetTitle && title === targetTitle) score += 50;
        else if (title && targetTitle && (title.includes(targetTitle) || targetTitle.includes(title))) score += 30;
        if (targetYear && year.includes(targetYear)) score += 20;
        return { item, score };
    }).sort((a, b) => b.score - a.score);

    return scored[0]?.item || results[0];
};

const getItemName = (item) => String(item?.file_name || item?.name || item?.title || item?.fileName || '').trim();

const parseEpisodeNumber = (name) => {
    const text = String(name || '');
    const sxe = text.match(/S\d{1,2}E(\d{1,3})/i);
    if (sxe) return Number(sxe[1]);
    const ep = text.match(/\b(?:E|EP|Episode)\s*0*(\d{1,3})\b/i);
    return ep ? Number(ep[1]) : null;
};

const selectFebboxFile = async ({ apiBaseUrl, shareKey, files, tmdbType, seasonNum, episodeNum, cookie }) => {
    const authHeaders = cookie ? { 'x-auth-cookie': cookie.replace(/^ui=/, '') } : {};
    const listFiles = async (parentId = 0) => {
        const response = await axios.get(`${apiBaseUrl}/api/febbox/files`, {
            params: { shareKey, parent_id: parentId },
            headers: authHeaders,
            timeout: 30000
        });
        return Array.isArray(response.data) ? response.data : [];
    };

    if (!(tmdbType === 'tv' || tmdbType === 'series')) {
        return files
            .filter(file => !file.is_dir)
            .sort((a, b) => parseSizeToBytes(getItemName(b)) - parseSizeToBytes(getItemName(a)))[0] || null;
    }

    const seasonLabel = seasonNum !== null ? String(seasonNum).padStart(2, '0') : null;
    const folderCandidates = files.filter(file => file.is_dir);
    const matchingSeasonFolder = folderCandidates.find(file => {
        const name = getItemName(file).toLowerCase();
        return name.includes(`season ${seasonNum}`) ||
            name.includes(`season ${seasonLabel}`) ||
            name.includes(`s${seasonLabel}`) ||
            name === String(seasonNum);
    }) || folderCandidates[0];

    const episodeFiles = matchingSeasonFolder
        ? await listFiles(matchingSeasonFolder.fid)
        : files;

    return episodeFiles
        .filter(file => !file.is_dir)
        .find(file => parseEpisodeNumber(getItemName(file)) === Number(episodeNum)) ||
        episodeFiles.filter(file => !file.is_dir)[0] ||
        null;
};

const getStreamsFromShowboxFebboxApi = async (tmdbType, tmdbId, seasonNum = null, episodeNum = null, cookies = null) => {
    if (!SHOWBOX_FEBBOX_API_URL) return [];

    const apiBaseUrl = SHOWBOX_FEBBOX_API_URL;
    const { cookie: selectedCookie } = await selectBestCookie(cookies);
    const authHeaders = selectedCookie ? { 'x-auth-cookie': selectedCookie.replace(/^ui=/, '') } : {};
    const mediaInfo = await getTmdbMediaDetails(tmdbType, tmdbId);
    if (!mediaInfo?.title) return [];

    try {
        console.log(`[ShowBox Fallback] Searching ${apiBaseUrl} for "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);
        const searchType = tmdbType === 'tv' || tmdbType === 'series' ? 'tv' : 'movie';
        const searchResponse = await axios.get(`${apiBaseUrl}/api/search`, {
            params: { type: searchType, title: mediaInfo.title, page: 1, pagelimit: 20 },
            timeout: 30000
        });
        const searchResults = Array.isArray(searchResponse.data) ? searchResponse.data : [];
        const showboxItem = selectBestShowboxSearchResult(searchResults, mediaInfo);
        if (!showboxItem?.id) {
            console.log('[ShowBox Fallback] No matching ShowBox item found.');
            return [];
        }

        const boxType = showboxItem.box_type || (searchType === 'tv' ? 2 : 1);
        const febboxIdResponse = await axios.get(`${apiBaseUrl}/api/febbox/id`, {
            params: { id: showboxItem.id, type: boxType },
            timeout: 45000
        });
        const shareKey = febboxIdResponse.data?.febBoxId;
        if (!shareKey) {
            console.log('[ShowBox Fallback] No FebBox share key returned.');
            return [];
        }

        const filesResponse = await axios.get(`${apiBaseUrl}/api/febbox/files`, {
            params: { shareKey, parent_id: 0 },
            headers: authHeaders,
            timeout: 30000
        });
        const files = Array.isArray(filesResponse.data) ? filesResponse.data : [];
        const file = await selectFebboxFile({
            apiBaseUrl,
            shareKey,
            files,
            tmdbType,
            seasonNum,
            episodeNum,
            cookie: selectedCookie
        });
        if (!file?.fid) {
            console.log('[ShowBox Fallback] No playable FebBox file found.');
            return [];
        }

        const linksResponse = await axios.get(`${apiBaseUrl}/api/febbox/links`, {
            params: { shareKey, fid: file.fid },
            headers: authHeaders,
            timeout: 30000
        });
        const links = Array.isArray(linksResponse.data) ? linksResponse.data : [];
        const fileName = getItemName(file);

        const streams = links
            .filter(link => link && link.url)
            .map(link => {
                const label = [link.quality, link.name, fileName].filter(Boolean).join(' ');
                return {
                    name: link.name || link.quality || 'FebBox',
                    title: fileName || mediaInfo.title,
                    url: link.url,
                    quality: parseQualityFromLabel(label),
                    codecs: extractCodecDetails(label),
                    size: link.size || file.size || file.file_size || 'Unknown size',
                    provider: 'ShowBox'
                };
            });

        console.log(`[ShowBox Fallback] Parsed ${streams.length} stream(s) from showbox-febbox-api.`);
        return sortStreamsByQuality(streams);
    } catch (error) {
        const errorMessage = error.response ? `${error.message} (Status: ${error.response.status})` : error.message;
        console.error(`[ShowBox Fallback] Error: ${errorMessage}`);
        return [];
    }
};

/**
 * Select the best cookie from an array of cookies
 * Tries to check quota for each, picks the one with highest remaining quota
 * Falls back to any cookie if quota checks fail
 * @param {string|string[]} cookies - Single cookie string or array of cookies
 * @returns {Promise<{cookie: string|null, remainingMB: number}>}
 */
const selectBestCookie = async (cookies) => {
    // Normalize to array
    let cookieArray = [];
    if (typeof cookies === 'string' && cookies.trim()) {
        cookieArray = [cookies.trim()];
    } else if (Array.isArray(cookies)) {
        cookieArray = cookies.filter(c => c && typeof c === 'string' && c.trim()).map(c => c.trim());
    }

    if (cookieArray.length === 0) {
        return { cookie: null, remainingMB: -1 };
    }

    // If only one cookie, use it directly (optionally check quota)
    if (cookieArray.length === 1) {
        const quotaResult = await checkCookieQuota(cookieArray[0]);
        // global.currentRequestUserCookie = quotaResult.cookie; // REMOVED: Thread-unsafe
        // global.currentRequestUserCookieRemainingMB = quotaResult.ok ? quotaResult.remainingMB : undefined; // REMOVED: Thread-unsafe
        console.log(`[ShowBox] Using single cookie${quotaResult.ok ? ` (${quotaResult.remainingMB} MB remaining)` : ' (quota check skipped/failed)'}`);
        return { cookie: quotaResult.cookie, remainingMB: quotaResult.remainingMB };
    }

    // Multiple cookies - try to check quota for all in parallel
    console.log(`[ShowBox] Checking quota for ${cookieArray.length} cookies...`);
    const quotaPromises = cookieArray.map(c => checkCookieQuota(c));
    const results = await Promise.all(quotaPromises);

    // Separate successful quota checks from failed ones
    const successfulChecks = results.filter(r => r.ok);
    const failedChecks = results.filter(r => !r.ok);

    if (successfulChecks.length > 0) {
        // Sort by remaining quota descending and pick the best
        successfulChecks.sort((a, b) => b.remainingMB - a.remainingMB);
        const best = successfulChecks[0];
        // global.currentRequestUserCookie = best.cookie; // REMOVED: Thread-unsafe
        // global.currentRequestUserCookieRemainingMB = best.remainingMB; // REMOVED: Thread-unsafe
        console.log(`[ShowBox] Selected best cookie by quota: ${best.remainingMB} MB remaining (out of ${successfulChecks.length} valid cookies)`);
        return { cookie: best.cookie, remainingMB: best.remainingMB };
    }

    // All quota checks failed - use the first cookie anyway (fallback)
    const fallbackCookie = cookieArray[0];
    // global.currentRequestUserCookie = fallbackCookie; // REMOVED: Thread-unsafe
    // global.currentRequestUserCookieRemainingMB = undefined; // REMOVED: Thread-unsafe
    console.log(`[ShowBox] All quota checks failed, using first cookie as fallback`);
    return { cookie: fallbackCookie, remainingMB: -1 };
};

/**
 * Main function to get streams from TMDB ID using the new API
 * @param {string} tmdbType - 'movie' or 'tv'
 * @param {string} tmdbId - TMDB ID
 * @param {number|null} seasonNum - Season number (for TV)
 * @param {number|null} episodeNum - Episode number (for TV)
 * @param {string|null} regionPreference - OSS region (e.g., 'USA7', 'IN1')
 * @param {string|string[]|null} cookies - Single cookie string or array of cookies
 * @param {string|null} userScraperApiKey - Not used in new implementation
 */
const getStreamsFromTmdbId = async (tmdbType, tmdbId, seasonNum = null, episodeNum = null, regionPreference = null, cookies = null, userScraperApiKey = null) => {
    const mainTimerLabel = `getStreamsFromTmdbId_total_${tmdbType}_${tmdbId}` + (seasonNum ? `_s${seasonNum}` : '') + (episodeNum ? `_e${episodeNum}` : '');
    console.time(mainTimerLabel);
    console.log(`[ShowBox] Getting streams for TMDB ${tmdbType}/${tmdbId}${seasonNum !== null ? `, Season ${seasonNum}` : ''}${episodeNum !== null ? `, Episode ${episodeNum}` : ''}`);

    try {
        if (SHOWBOX_FEBBOX_API_ONLY) {
            const fallbackStreams = await getStreamsFromShowboxFebboxApi(tmdbType, tmdbId, seasonNum, episodeNum, cookies);
            console.timeEnd(mainTimerLabel);
            return fallbackStreams;
        }

        // Select the best cookie from available cookies (single or array)
        const { cookie: selectedCookie, remainingMB } = await selectBestCookie(cookies);

        // Build API URL
        let apiUrl;
        const oss = regionPreference || 'USA7'; // Default to USA7 if no region preference

        if (tmdbType === 'tv' || tmdbType === 'series') {
            if (seasonNum === null || episodeNum === null) {
                console.log(`[ShowBox] TV show requires both season and episode numbers`);
                console.timeEnd(mainTimerLabel);
                return [];
            }
            apiUrl = `${FEBAPI_BASE_URL}/tv/${tmdbId}/oss=${oss}/${seasonNum}/${episodeNum}`;
        } else if (tmdbType === 'movie') {
            apiUrl = `${FEBAPI_BASE_URL}/movie/${tmdbId}/oss=${oss}`;
        } else {
            console.log(`[ShowBox] Unsupported media type: ${tmdbType}`);
            console.timeEnd(mainTimerLabel);
            return [];
        }

        // Add cookie as query parameter if available
        if (selectedCookie) {
            apiUrl += `?cookie=${encodeURIComponent(selectedCookie)}`;
        }

        console.log(`[ShowBox] Making request to: ${apiUrl.replace(/\?cookie=.*/, '?cookie=***')}`); // Hide cookie in logs

        // Make API request
        const response = await axios.get(apiUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'NuvioStreamsAddon/1.0'
            }
        });

        if (!response.data || !response.data.success) {
            console.log(`[ShowBox] API returned unsuccessful response`);
            console.timeEnd(mainTimerLabel);
            return [];
        }

        const apiData = response.data;
        const streams = [];

        // Process versions array
        if (apiData.versions && Array.isArray(apiData.versions)) {
            for (const version of apiData.versions) {
                const versionName = version.name || 'Unknown';
                const versionSize = version.size || 'Unknown size';

                // Process links array for each version
                if (version.links && Array.isArray(version.links)) {
                    for (const link of version.links) {
                        if (!link.url) {
                            continue; // Skip links without URL
                        }

                        const streamName = link.name || 'Auto';
                        const streamTitle = versionName;
                        const streamUrl = link.url;
                        const streamQuality = parseQualityFromLabel(link.quality || link.name);
                        const streamSize = link.size || versionSize;
                        const streamCodecs = extractCodecDetails(versionName);

                        streams.push({
                            name: streamName,
                            title: streamTitle,
                            url: streamUrl,
                            quality: streamQuality,
                            codecs: streamCodecs,
                            size: streamSize,
                            provider: 'ShowBox'
                        });
                    }
                }
            }
        }

        console.log(`[ShowBox] Successfully parsed ${streams.length} streams from API response`);

        // Sort streams by quality before returning
        const sortedStreams = sortStreamsByQuality(streams);
        if (sortedStreams.length === 0 && SHOWBOX_FEBBOX_API_URL) {
            const fallbackStreams = await getStreamsFromShowboxFebboxApi(tmdbType, tmdbId, seasonNum, episodeNum, cookies);
            if (fallbackStreams.length > 0) {
                console.log(`[ShowBox] Using ${fallbackStreams.length} stream(s) from showbox-febbox-api fallback.`);
                console.timeEnd(mainTimerLabel);
                return fallbackStreams;
            }
        }
        console.timeEnd(mainTimerLabel);
        return sortedStreams;

    } catch (error) {
        const errorMessage = error.response ? `${error.message} (Status: ${error.response.status})` : error.message;
        console.error(`[ShowBox] Error fetching streams: ${errorMessage}`);
        if (error.response && error.response.data) {
            console.error(`[ShowBox] Response data:`, JSON.stringify(error.response.data).substring(0, 500));
        }
        if (SHOWBOX_FEBBOX_API_URL) {
            const fallbackStreams = await getStreamsFromShowboxFebboxApi(tmdbType, tmdbId, seasonNum, episodeNum, cookies);
            if (fallbackStreams.length > 0) {
                console.log(`[ShowBox] Using ${fallbackStreams.length} stream(s) from showbox-febbox-api fallback after primary failure.`);
                console.timeEnd(mainTimerLabel);
                return fallbackStreams;
            }
        }
        console.timeEnd(mainTimerLabel);
        return [];
    }
};

// Export required functions
module.exports = {
    getStreamsFromTmdbId,
    parseQualityFromLabel,
    convertImdbToTmdb,
    sortStreamsByQuality
};
