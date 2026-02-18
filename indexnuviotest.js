const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const { TextDecoder } = require('util');


// Zmienna globalna dla BASE_URL - ustawiana przy starcie serwera
let BASE_URL_RESOLVED = '';

// Konfiguracja
const BASE_URL = 'http://animesub.info';
const SEARCH_URL = `${BASE_URL}/szukaj.php`;
const DOWNLOAD_URL = `${BASE_URL}/sciagnij.php`;

// Manifest wtyczki
const manifest = {
    id: 'community.animesub.info',
    version: '1.2.0', // Podbita wersja, aby wymusić przeładowanie w Nuvio
    name: 'AnimeSub.info Subtitles',
    description: 'Polskie napisy do anime z animesub.info',
    logo: 'https://i.imgur.com/qKLYVZx.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
        configurable: false,
        configurationRequired: false,
        proxyStreams: true 
    }
};

const builder = new addonBuilder(manifest);

// Sesja HTTP z odpowiednimi nagłówkami
const session = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Charset': 'ISO-8859-2,utf-8;q=0.7,*;q=0.3',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl,en;q=0.9'
    },
    responseType: 'arraybuffer',
    timeout: 15000
});

// Cache dla wyników wyszukiwania
const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minut

/**
 * Pobiera informacje o tytule z IMDB/Kitsu
 */
async function getMetaInfo(type, id) {
    const parts = id.split(':');
    const prefix = parts[0];
    
    let season = null;
    let episode = null;
    let title = null;
    let year = null;

    if (prefix === 'kitsu') {
        const kitsuId = parts[1];
        episode = parts.length >= 3 ? parseInt(parts[2], 10) : null;
        season = 1;

        try {
            const kitsuUrl = `https://kitsu.io/api/edge/anime/${kitsuId}`;
            const response = await axios.get(kitsuUrl, {
                headers: {
                    'Accept': 'application/vnd.api+json',
                    'Content-Type': 'application/vnd.api+json'
                },
                timeout: 10000
            });
            
            const anime = response.data.data.attributes;
            title = anime.titles?.en || anime.titles?.en_jp || anime.canonicalTitle || anime.titles?.ja_jp;
            year = anime.startDate ? parseInt(anime.startDate.substring(0, 4), 10) : null;
            
            console.log(`[Kitsu] Pobrano: "${title}" (${year})`);
        } catch (error) {
            console.error('[Kitsu] Błąd pobierania metadanych:', error.message);
        }
        
        return { title, year, season, episode, kitsuId };
        
    } else {
        const imdbId = parts[0];
        if (type === 'series' && parts.length >= 3) {
            season = parseInt(parts[1], 10);
            episode = parseInt(parts[2], 10);
        }

        const metaUrl = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        let lastError = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`[Cinemeta] Próba ${attempt} dla ${imdbId}...`);
                const response = await axios.get(metaUrl, { timeout: 12000 });
                const meta = response.data.meta;

                return {
                    title: meta.name,
                    year: meta.year,
                    season,
                    episode,
                    imdbId
                };
            } catch (error) {
                lastError = error;
                if (attempt === 1) console.log(`[Cinemeta] Timeout/Błąd (5000ms+), ponawiam...`);
            }
        }

        console.error('Błąd pobierania metadanych z Cinemeta po retry:', lastError.message);
        return { imdbId, season, episode, title: null, year: null };
    }
}

async function searchSubtitles(title, titleType = 'en') {
    const cacheKey = `${title}:${titleType}`;
    const cached = searchCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`[Cache hit] ${title}`);
        return cached.results;
    }

    console.log(`[Szukanie] "${title}" (typ: ${titleType})`);

    try {
        const response = await session.get(SEARCH_URL, {
            params: {
                szukane: title,
                pTitle: titleType,
                pSortuj: 'pobrn'
            }
        });

        const html = iconv.decode(Buffer.from(response.data), 'ISO-8859-2');
        const results = parseSearchResults(html);

        searchCache.set(cacheKey, { results, timestamp: Date.now() });
        console.log(`[Znaleziono] ${results.length} napisów`);

        return results;
    } catch (error) {
        console.error('Błąd wyszukiwania:', error.message);
        return [];
    }
}

function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const subtitles = [];

    $('table.Napisy[style*="text-align:center"]').each((i, table) => {
        try {
            const rows = $(table).find('tr.KNap');
            if (rows.length < 3) return;

            const row1Cells = $(rows[0]).find('td');
            const titleOrg = $(row1Cells[0]).text().trim();
            const formatType = $(row1Cells[3]).text().trim();

            const row2Cells = $(rows[1]).find('td');
            const titleEng = $(row2Cells[0]).text().trim();
            const author = $(row2Cells[1]).find('a').text().trim() || $(row2Cells[1]).text().trim().replace(/^~/, '');

            const row3Cells = $(rows[2]).find('td');
            const titleAlt = $(row3Cells[0]).text().trim();
            let downloadCount = 0;
            if (row3Cells.length > 3) {
                const countText = $(row3Cells[3]).text().trim();
                downloadCount = parseInt(countText.split(' ')[0], 10) || 0;
            }

            const downloadRow = $(table).find('tr.KKom');
            const form = downloadRow.find('form[method="POST"]');
            const subtitleId = form.find('input[name="id"]').val();
            const downloadHash = form.find('input[name="sh"]').val();

            const description = downloadRow.find('td.KNap[align="left"]').text().trim();

            if (!subtitleId || !downloadHash) return;

            const episodeInfo = parseEpisodeInfo(titleOrg, titleEng, titleAlt);

            subtitles.push({
                id: subtitleId,
                hash: downloadHash,
                titleOrg,
                titleEng,
                titleAlt,
                author,
                formatType,
                downloadCount,
                description,
                ...episodeInfo
            });
        } catch (error) {
            console.error('Błąd parsowania wiersza:', error.message);
        }
    });

    return subtitles;
}

function parseEpisodeInfo(titleOrg, titleEng, titleAlt) {
    let season = null;
    let episode = null;
    const titles = [titleOrg, titleEng, titleAlt].filter(Boolean);

    for (const title of titles) {
        if (episode === null) {
            const epMatch = title.match(/(?:ep|episode)\s*(\d+)/i);
            if (epMatch) {
                episode = parseInt(epMatch[1], 10);
            }
        }
        if (season === null) {
            const seasonMatch = title.match(/(?:Season|S)\s*(\d+)|(\d+)(?:nd|rd|th)\s+Season/i);
            if (seasonMatch) {
                season = parseInt(seasonMatch[1] || seasonMatch[2], 10);
            }
        }
        if (season === null && episode !== null) {
            const implicitMatch = title.match(/\s(\d)\s+ep\d+/i);
            if (implicitMatch) {
                season = parseInt(implicitMatch[1], 10);
            }
        }
    }
    return { season, episode };
}

function generateSearchStrategies(title, season, episode) {
    const strategies = [];
    const cleanTitle = title.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

    if (episode !== null) {
        const epStr = String(episode).padStart(2, '0');
        if (season && season > 1) {
            strategies.push({ type: 'en', query: `${cleanTitle} Season ${season} ep${epStr}` });
            strategies.push({ type: 'en', query: `${cleanTitle} ${season} ep${epStr}` });
            strategies.push({ type: 'en', query: `${cleanTitle} S${season} ep${epStr}` });
        }
        strategies.push({ type: 'org', query: `${cleanTitle} ep${epStr}` });
        strategies.push({ type: 'en', query: `${cleanTitle} ep${epStr}` });
        if (season && season > 1) {
            strategies.push({ type: 'en', query: `${cleanTitle} Season ${season}` });
            strategies.push({ type: 'en', query: `${cleanTitle} ${season}` });
        }
    }
    strategies.push({ type: 'org', query: cleanTitle });
    strategies.push({ type: 'en', query: cleanTitle });
    return strategies;
}

function matchSubtitles(subtitles, targetSeason, targetEpisode) {
    return subtitles.filter(sub => {
        if (targetEpisode !== null && sub.episode !== null) {
            if (sub.episode !== targetEpisode) return false;
        }
        if (targetSeason !== null && sub.season !== null) {
            if (sub.season !== targetSeason) return false;
        }
        if (targetSeason === 1 && sub.season === null) {
            return true;
        }
        return true;
    });
}

function createSubtitleUrl(subtitle, searchQuery, searchType, format = 'srt') {
    const queryBase64 = Buffer.from(searchQuery).toString('base64');
    // Używamy "subs.format" na końcu, aby MPV nie miał wątpliwości
    return `${BASE_URL_RESOLVED}/subtitles/download/${subtitle.id}/${subtitle.hash}/${queryBase64}/${searchType}/subs.${format}`;
}


builder.defineSubtitlesHandler(async ({ type, id }) => {
    console.log(`\n[Request] type=${type}, id=${id}`);
    try {
        const meta = await getMetaInfo(type, id);
        if (!meta.title) return { subtitles: [] };

        const strategies = generateSearchStrategies(meta.title, meta.season, meta.episode);
        let allSubtitles = [];
        const seenIds = new Set();

        for (const strategy of strategies) {
            const results = await searchSubtitles(strategy.query, strategy.type);
            const matched = matchSubtitles(results, meta.season, meta.episode);

            for (const sub of matched) {
                if (!seenIds.has(sub.id)) {
                    seenIds.add(sub.id);
                    allSubtitles.push({
                        ...sub,
                        searchQuery: strategy.query,
                        searchType: strategy.type
                    });
                }
            }
            const exactMatch = matched.some(s => s.episode === meta.episode && (meta.season === null || meta.season === 1 || s.season === meta.season));
            if (exactMatch && matched.length >= 1) break;
            if (allSubtitles.length >= 5) break;
        }

        allSubtitles.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));

        const stremioSubtitles = allSubtitles.slice(0, 10).map(sub => {
            let format = 'srt';
            const descLower = (sub.description || '').toLowerCase();
            const typeLower = (sub.formatType || '').toLowerCase();

            if (descLower.includes('.ass') || typeLower.includes('ass')) {
                format = 'ass';
            } else if (descLower.includes('.ssa') || typeLower.includes('ssa')) {
                format = 'ssa';
            }
            
            const label = [
                sub.titleEng || sub.titleOrg,
                sub.author ? `by ${sub.author}` : null,
                `[${format.toUpperCase()}]`,
                sub.downloadCount ? `${sub.downloadCount} pobrań` : null
            ].filter(Boolean).join(' | ');

            return {
                id: `animesub-${sub.id}`,
                url: createSubtitleUrl(sub, sub.searchQuery, sub.searchType, format),
                lang: 'pol',
                SubtitleName: label
            };
        });

        return { subtitles: stremioSubtitles };
    } catch (error) {
        console.error('[Błąd]', error);
        return { subtitles: [] };
    }
});

async function extractWith7z(zipBuffer) {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tmpDir = os.tmpdir();
    const tmpZipPath = path.join(tmpDir, `subtitle_${Date.now()}_${Math.random().toString(36).substring(7)}.zip`);
    
    try {
        fs.writeFileSync(tmpZipPath, zipBuffer);
        const listResult = spawnSync('7z', ['l', '-slt', tmpZipPath], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
        if (listResult.error) throw listResult.error;
        
        const lines = listResult.stdout.split('\n');
        let subtitleFileName = null;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('Path = ')) {
                const fileName = lines[i].substring(7).trim();
                if (/\.(txt|srt|ass|ssa|sub)$/i.test(fileName)) {
                    subtitleFileName = fileName;
                    break;
                }
            }
        }
        if (!subtitleFileName) return null;
        
        const extractResult = spawnSync('7z', ['e', '-so', tmpZipPath, subtitleFileName], { maxBuffer: 10 * 1024 * 1024 });
        if (extractResult.error) throw extractResult.error;
        
        return { content: extractResult.stdout, extension: path.extname(subtitleFileName).toLowerCase() };
    } catch (error) {
        console.error(`[7z] BŁĄD:`, error.message);
        throw error;
    } finally {
        try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) {}
    }
}

function sniffUtf16NoBom(buf) {
    const len = Math.min(buf.length, 2000);
    if (len < 8) return null;
    let zerosEven = 0, zerosOdd = 0, pairs = 0;
    for (let i = 0; i < len - 1; i += 2) {
        if (buf[i] === 0x00) zerosEven++;
        if (buf[i + 1] === 0x00) zerosOdd++;
        pairs++;
    }
    const evenRatio = zerosEven / pairs;
    const oddRatio  = zerosOdd  / pairs;
    if (oddRatio > 0.30 && evenRatio < 0.05) return 'utf-16le';
    if (evenRatio > 0.30 && oddRatio < 0.05) return 'utf-16be';
    return null;
}

function tryDecodeUtf8Strict(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

function scorePolishText(t) {
    let score = 0;
    const pl = t.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g);
    if (pl) score += pl.length * 3;
    const mojibake = t.match(/[ÃÅÄĹĽÐÑÒÓÕÖØ]/g);
    if (mojibake) score -= mojibake.length * 2;
    const ctrl = t.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);
    if (ctrl) score -= ctrl.length * 5;
    return score;
}

function decodeSubtitleBuffer(buf) {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { text: buf.slice(3).toString('utf8'), encoding: 'utf8-bom' };
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: iconv.decode(buf.slice(2), 'utf-16le'), encoding: 'utf16le-bom' };
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return { text: iconv.decode(buf.slice(2), 'utf-16be'), encoding: 'utf16be-bom' };
    const utf16 = sniffUtf16NoBom(buf);
    if (utf16) return { text: iconv.decode(buf, utf16), encoding: utf16 };
    const utf8 = tryDecodeUtf8Strict(buf);
    if (utf8 !== null) return { text: utf8, encoding: 'utf8' };
    const c1 = { enc: 'windows-1250', text: iconv.decode(buf, 'windows-1250') };
    const c2 = { enc: 'ISO-8859-2',  text: iconv.decode(buf, 'ISO-8859-2')  };
    return (scorePolishText(c1.text) >= scorePolishText(c2.text)) ? { text: c1.text, encoding: c1.enc } : { text: c2.text, encoding: c2.enc };
}

function toUtf8BufferNoBom(text, extension = '') {
    let cleaned = (text || '').replace(/\u0000/g, '');
    
    // MPV / Android / libass rygorystyczne formatowanie
    if (extension === '.ass' || extension === '.ssa') {
        if (!cleaned.includes('[Script Info]')) {
            cleaned = `[Script Info]\r\nScriptType: v4.00+\r\nPlayResX: 384\r\nPlayResY: 288\r\nScaledBorderAndShadow: yes\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n` + cleaned;
        }
    }
    // Zawsze wysyłamy UTF-8 bez BOM dla maksymalnej kompatybilności
    return Buffer.from(cleaned, 'utf8');
}

/**
 * GŁÓWNA FUNKCJA PROXY - OPTYMALIZACJA POD MPV ANDROID
 */
async function downloadSubtitleProxy(id, hash, query, type, format, req, res) {
    console.log(`[Proxy] Start: id=${id}, format=${format}`);

    if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
    }

    try {
        const downloadSession = axios.create({
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Charset': 'ISO-8859-2,utf-8;q=0.7,*;q=0.3' },
            timeout: 15000, responseType: 'arraybuffer'
        });

        // 1. Pozyskanie ciasteczek i hasha
        const searchUrl = `${SEARCH_URL}?szukane=${encodeURIComponent(query)}&pTitle=${type}&pSortuj=pobrn`;
        const searchResponse = await downloadSession.get(searchUrl);
        const cookies = searchResponse.headers['set-cookie'] || [];
        const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
        
        const $ = cheerio.load(iconv.decode(Buffer.from(searchResponse.data), 'ISO-8859-2'));
        let freshHash = hash;
        $('form[action="sciagnij.php"]').each((i, form) => {
            if ($(form).find('input[name="id"]').val() === id) freshHash = $(form).find('input[name="sh"]').val();
        });

        // 2. Pobranie pliku
        const downloadResponse = await downloadSession.post(DOWNLOAD_URL, 
            new URLSearchParams({ id, sh: freshHash, single_file: 'Pobierz napisy' }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': searchUrl, 'Cookie': cookieString }, responseType: 'arraybuffer' }
        );

        let content = Buffer.from(downloadResponse.data);
        let ext = `.${format}`;
        
        // 3. Obsługa ZIP
        if (content[0] === 0x50 && content[1] === 0x4B) {
            const zipResult = await extractWith7z(content) || { content, extension: ext };
            content = zipResult.content;
            ext = zipResult.extension;
        }

        // 4. Dekodowanie i konwersja na czysty UTF-8 (BEZ BOM)
        const decoded = decodeSubtitleBuffer(content);
        const outBuf = toUtf8BufferNoBom(decoded.text, ext);

        // 5. Wysyłka z nagłówkiem, który MPV traktuje jako "surowy"
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream', // Kluczowa zmiana dla MPV Android
            'Content-Length': outBuf.length,
            'Access-Control-Allow-Origin': '*',
            'Content-Disposition': `attachment; filename="subs${ext}"`,
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        
        res.end(outBuf);
        console.log(`[Proxy] ✓ OK: Wysłano ${outBuf.length} bajtów (format: ${ext})`);
    } catch (e) {
        console.error('[Proxy Błąd]', e.message);
        res.writeHead(500); res.end();
    }
}

const PORT = process.env.PORT || 7000;
const http = require('http');

if (process.env.BASE_URL) BASE_URL_RESOLVED = process.env.BASE_URL;
else if (process.env.SPACE_HOST) BASE_URL_RESOLVED = `https://${process.env.SPACE_HOST}`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathParts = url.pathname.split('/');

    if (url.pathname.startsWith('/subtitles/download/') && pathParts.length >= 7) {
        const id = pathParts[3];
        const hash = pathParts[4];
        const query = Buffer.from(pathParts[5], 'base64').toString('utf-8');
        const type = pathParts[6];
        const format = (pathParts[7] || '').split('.').pop() || 'srt';
        
        downloadSubtitleProxy(id, hash, query, type, format, req, res);
        return;
    }

    if (url.pathname === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(manifest));
    } else {
        const router = getRouter(builder.getInterface());
        router(req, res, () => { res.writeHead(404); res.end(); });
    }
});

server.listen(PORT, () => console.log(`Serwer na porcie ${PORT}`));
