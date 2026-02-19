// core.js - Współdzielona logika wtyczki AnimeSub dla Vercel
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const { TextDecoder } = require('util');

// Konfiguracja
const BASE_URL = 'http://animesub.info';
const SEARCH_URL = `${BASE_URL}/szukaj.php`;
const DOWNLOAD_URL = `${BASE_URL}/sciagnij.php`;

// Pobieranie BASE_URL dla Vercel (zmienna środowiskowa VERCEL_URL lub BASE_URL)
function getBaseUrl(req) {
    if (process.env.BASE_URL) return process.env.BASE_URL;
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    // Fallback - wykryj z requesta
    if (req) {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        if (host) return `${proto}://${host}`;
    }
    return '';
}

// Sesja HTTP - agresywne timeouty dla Vercel (limit 10s Free / 30s Pro)
const session = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Charset': 'ISO-8859-2,utf-8;q=0.7,*;q=0.3',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl,en;q=0.9'
    },
    responseType: 'arraybuffer',
    timeout: 5000, // 5s max per request - zostawia bufor na przetwarzanie
    maxRedirects: 2
});

// In-memory cache (działa w ramach jednej instancji cold-start)
const searchCache = new Map();
const metaCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const META_CACHE_TTL = 60 * 60 * 1000;

function cleanCache() {
    const now = Date.now();
    for (const [key, value] of searchCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) searchCache.delete(key);
    }
    for (const [key, value] of metaCache.entries()) {
        if (now - value.timestamp > META_CACHE_TTL) metaCache.delete(key);
    }
}

async function getMetaInfo(type, id) {
    const cacheKey = `${type}:${id}`;
    cleanCache();
    const cached = metaCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < META_CACHE_TTL) return cached.data;

    const parts = id.split(':');
    const prefix = parts[0];
    let season = null, episode = null, title = null, year = null;

    if (prefix === 'kitsu') {
        const kitsuId = parts[1];
        episode = parts.length >= 3 ? parseInt(parts[2], 10) : null;
        season = 1;
        try {
            const kitsuUrl = `https://kitsu.io/api/edge/anime/${kitsuId}`;
            const response = await axios.get(kitsuUrl, {
                headers: { 'Accept': 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' },
                timeout: 4000
            });
            const anime = response.data.data.attributes;
            title = anime.titles?.en || anime.titles?.en_jp || anime.canonicalTitle || anime.titles?.ja_jp;
            year = anime.startDate ? parseInt(anime.startDate.substring(0, 4), 10) : null;
            console.log(`[Kitsu] Pobrano: "${title}" (${year})`);
        } catch (error) {
            console.error('[Kitsu] Błąd:', error.message);
        }
        const result = { title, year, season, episode, kitsuId };
        metaCache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
    } else {
        const imdbId = parts[0];
        if (type === 'series' && parts.length >= 3) {
            season = parseInt(parts[1], 10);
            episode = parseInt(parts[2], 10);
        }
        const metaUrl = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        try {
            const response = await axios.get(metaUrl, { timeout: 4000 });
            const meta = response.data.meta;
            const result = { title: meta.name, year: meta.year, season, episode, imdbId };
            metaCache.set(cacheKey, { data: result, timestamp: Date.now() });
            return result;
        } catch (error) {
            console.error('[Cinemeta] Błąd:', error.message);
        }
        return { imdbId, season, episode, title: null, year: null };
    }
}

async function searchSubtitles(title, titleType = 'en') {
    const cacheKey = `${title}:${titleType}`;
    cleanCache();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results;

    console.log(`[Szukanie] "${title}" (typ: ${titleType})`);
    try {
        const response = await session.get(SEARCH_URL, {
            params: { szukane: title, pTitle: titleType, pSortuj: 'pobrn' }
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
            subtitles.push({ id: subtitleId, hash: downloadHash, titleOrg, titleEng, titleAlt, author, formatType, downloadCount, description, ...episodeInfo });
        } catch (error) {
            console.error('Błąd parsowania wiersza:', error.message);
        }
    });
    return subtitles;
}

function parseEpisodeInfo(titleOrg, titleEng, titleAlt) {
    let season = null, episode = null;
    const titles = [titleOrg, titleEng, titleAlt].filter(Boolean);
    for (const title of titles) {
        if (episode === null) {
            const epMatch = title.match(/(?:ep|episode)\s*(\d+)/i);
            if (epMatch) episode = parseInt(epMatch[1], 10);
        }
        if (season === null) {
            const seasonMatch = title.match(/(?:Season|S)\s*(\d+)|(\d+)(?:nd|rd|th)\s+Season/i);
            if (seasonMatch) season = parseInt(seasonMatch[1] || seasonMatch[2], 10);
        }
        if (season === null && episode !== null) {
            const implicitMatch = title.match(/\s(\d)\s+ep\d+/i);
            if (implicitMatch) season = parseInt(implicitMatch[1], 10);
        }
        if (season !== null && episode !== null) break;
    }
    return { season, episode };
}

function generateSearchStrategies(title, season, episode) {
    const strategies = [];
    const cleanTitle = title.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    const add = (type, query) => {
        const key = `${type}:${query}`;
        if (!seen.has(key)) { seen.add(key); strategies.push({ type, query }); }
    };

    if (episode !== null) {
        const epStr = String(episode).padStart(2, '0');
        // Strategia 1: najbardziej precyzyjna
        if (season && season > 1) {
            add('en', `${cleanTitle} Season ${season} ep${epStr}`);
        } else {
            add('org', `${cleanTitle} ep${epStr}`);
        }
        // Strategia 2: bez sezonu (fallback)
        add('en', `${cleanTitle} ep${epStr}`);
    }
    // Strategia 3: sam tytuł (ostateczność)
    add('org', cleanTitle);

    return strategies; // max 3 zapytania zamiast 6-8
}

function matchSubtitles(subtitles, targetSeason, targetEpisode) {
    if (targetEpisode === null && targetSeason === null) return subtitles;
    return subtitles.filter(sub => {
        if (targetEpisode !== null && sub.episode !== null && sub.episode !== targetEpisode) return false;
        if (targetSeason !== null && sub.season !== null && sub.season !== targetSeason) return false;
        if (targetSeason === 1 && sub.season === null) return true;
        return true;
    });
}

function createSubtitleUrl(subtitle, searchQuery, searchType, format = 'srt', baseUrl = '', convertToVtt = false) {
    const params = new URLSearchParams({
        id: subtitle.id,
        hash: subtitle.hash,
        query: searchQuery,
        type: searchType,
        format
    });
    if (convertToVtt) params.set('convert', 'vtt');
    const ext = convertToVtt ? 'vtt' : format;
    return `${baseUrl}/subtitles/download.${ext}?${params.toString()}`;
}

// ----- Dekodowanie -----

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
    const oddRatio = zerosOdd / pairs;
    if (oddRatio > 0.30 && evenRatio < 0.05) return 'utf-16le';
    if (evenRatio > 0.30 && oddRatio < 0.05) return 'utf-16be';
    return null;
}

function tryDecodeUtf8Strict(buf) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        return null;
    }
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
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return { text: buf.slice(3).toString('utf8'), encoding: 'utf8-bom' };
    }
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return { text: iconv.decode(buf.slice(2), 'utf-16le'), encoding: 'utf16le-bom' };
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        return { text: iconv.decode(buf.slice(2), 'utf-16be'), encoding: 'utf16be-bom' };
    }
    const utf16 = sniffUtf16NoBom(buf);
    if (utf16) return { text: iconv.decode(buf, utf16), encoding: utf16 };
    const utf8 = tryDecodeUtf8Strict(buf);
    if (utf8 !== null) return { text: utf8, encoding: 'utf8' };
    const c1 = { enc: 'windows-1250', text: iconv.decode(buf, 'windows-1250') };
    const c2 = { enc: 'ISO-8859-2', text: iconv.decode(buf, 'ISO-8859-2') };
    const s1 = scorePolishText(c1.text);
    const s2 = scorePolishText(c2.text);
    return (s1 >= s2) ? { text: c1.text, encoding: c1.enc } : { text: c2.text, encoding: c2.enc };
}

function toUtf8Buffer(text, addBOM = false) {
    const cleaned = (text || '').replace(/\u0000/g, '');
    if (addBOM) return Buffer.from('\uFEFF' + cleaned, 'utf8');
    return Buffer.from(cleaned, 'utf8');
}

function normalizeTimestamp(timestamp) {
    timestamp = timestamp.trim();
    if (/^\d+:\d{2}:\d{2}\.\d{2}$/.test(timestamp)) return timestamp;
    timestamp = timestamp.replace(',', '.');
    if (/^\d+:\d{2}:\d{2}$/.test(timestamp)) timestamp += '.00';
    timestamp = timestamp.replace(/^0+(\d:)/, '$1');
    return timestamp;
}

function fixDialogueTimestamps(content) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('Dialogue:') || line.startsWith('Comment:')) {
            const parts = line.split(',');
            if (parts.length >= 3) {
                parts[1] = normalizeTimestamp(parts[1]);
                parts[2] = normalizeTimestamp(parts[2]);
                lines[i] = parts.join(',');
            }
        }
    }
    return lines.join('\n');
}

function validateAndFixASS(content) {
    let lines = content.split(/\r?\n/).map(line => line.trimEnd());
    const hasScriptInfo = lines.some(line => line === '[Script Info]');
    const hasStyles = lines.some(line => line === '[V4+ Styles]');
    const hasEvents = lines.some(line => line === '[Events]');
    const hasScriptType = lines.some(line => line.startsWith('ScriptType:'));

    if (!hasScriptInfo || !hasStyles || !hasEvents || !hasScriptType) {
        const existingDialogues = lines.filter(line => line.startsWith('Dialogue:') || line.startsWith('Comment:'));
        const existingStyles = lines.filter(line => line.startsWith('Style:') && !line.startsWith('Style: Default'));
        const newLines = [
            '[Script Info]',
            'Title: Subtitle',
            'ScriptType: v4.00+',
            'WrapStyle: 0',
            'PlayResX: 1920',
            'PlayResY: 1080',
            'ScaledBorderAndShadow: yes',
            'YCbCr Matrix: TV.709',
            '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            'Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1'
        ];
        if (existingStyles.length > 0) newLines.push(...existingStyles);
        newLines.push('', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
        if (existingDialogues.length > 0) newLines.push(...existingDialogues);
        lines = newLines;
    } else {
        if (!hasScriptType) {
            const scriptInfoIdx = lines.findIndex(line => line === '[Script Info]');
            if (scriptInfoIdx >= 0) lines.splice(scriptInfoIdx + 1, 0, 'ScriptType: v4.00+');
        }
        const stylesIdx = lines.findIndex(line => line === '[V4+ Styles]');
        if (stylesIdx >= 0) {
            let hasStylesFormat = false, hasDefaultStyle = false;
            for (let i = stylesIdx + 1; i < lines.length && !lines[i].startsWith('['); i++) {
                if (lines[i].startsWith('Format:')) hasStylesFormat = true;
                if (lines[i].startsWith('Style: Default')) hasDefaultStyle = true;
            }
            if (!hasStylesFormat) {
                lines.splice(stylesIdx + 1, 0, 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
            }
            if (!hasDefaultStyle) {
                const formatIdx = lines.findIndex((line, idx) => idx > stylesIdx && line.startsWith('Format:'));
                if (formatIdx >= 0) lines.splice(formatIdx + 1, 0, 'Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1');
            }
        }
        const eventsIdx = lines.findIndex(line => line === '[Events]');
        if (eventsIdx >= 0) {
            let hasEventsFormat = false;
            for (let i = eventsIdx + 1; i < lines.length && !lines[i].startsWith('['); i++) {
                if (lines[i].startsWith('Format:')) { hasEventsFormat = true; break; }
            }
            if (!hasEventsFormat) lines.splice(eventsIdx + 1, 0, 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
        }
    }
    lines = lines.map(line => line.match(/^\s*\[.*\]$/) ? line.trim() : line);
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    return lines.join('\n');
}

/**
 * Konwersja ASS/SSA -> WebVTT
 * Obsługuje nakładające się napisy przez scalanie lub dodawanie pozycji VTT
 */
function assToVtt(assText) {
    const lines = assText.split('\n');
    const dialogues = [];

    for (const line of lines) {
        if (!line.startsWith('Dialogue:')) continue;

        // Format: Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
        const parts = line.split(',');
        if (parts.length < 10) continue;

        const start = assTimestampToVtt(parts[1].trim());
        const end   = assTimestampToVtt(parts[2].trim());
        if (!start || !end) continue;

        const rawText = parts.slice(9).join(',').trim();

        // Wykryj pozycję z tagów ASS przed ich usunięciem
        const position = detectAssPosition(rawText);
        const text = stripAssTags(rawText);

        if (!text) continue;
        dialogues.push({ start, end, text, position,
            startMs: vttToMs(start), endMs: vttToMs(end) });
    }

    // Sortuj chronologicznie
    dialogues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    // Scal nakładające się napisy w tym samym czasie i tej samej pozycji
    const merged = mergeOverlapping(dialogues);

    const body = merged.map((d, i) => {
        const cue = d.position
            ? `${i + 1}\n${d.start} --> ${d.end} ${d.position}`
            : `${i + 1}\n${d.start} --> ${d.end}`;
        return `${cue}\n${d.text}`;
    }).join('\n\n');

    return `WEBVTT\n\n${body}\n`;
}

/**
 * Scala nakładające się napisy o tym samym czasie i pozycji
 */
function mergeOverlapping(dialogues) {
    if (dialogues.length === 0) return [];
    const result = [];

    for (const d of dialogues) {
        // Szukaj poprzedniego cue z dokładnie tym samym czasem i pozycją
        const same = result.find(r =>
            r.start === d.start &&
            r.end   === d.end   &&
            r.position === d.position
        );

        if (same) {
            // Scal teksty przez nową linię
            same.text += '\n' + d.text;
        } else {
            result.push({ ...d });
        }
    }

    return result;
}

/**
 * Wykrywa pozycję z tagów ASS i zwraca odpowiadającą dyrektywę VTT
 * \an1-9 = alignment, \pos(x,y) = dokładna pozycja
 */
function detectAssPosition(rawText) {
    // \an1-9 - numeracja jak na klawiaturze numerycznej
    // 7 8 9 = góra, 4 5 6 = środek, 1 2 3 = dół
    const anMatch = rawText.match(/\{[^}]*\\an(\d)[^}]*\}/);
    if (anMatch) {
        const an = parseInt(anMatch[1], 10);
        // Pozycja pionowa
        const line = [1,2,3].includes(an) ? 'line:90%' :
                     [7,8,9].includes(an) ? 'line:10%' : 'line:50%';
        // Pozycja pozioma
        const position = [1,4,7].includes(an) ? 'position:10% align:left' :
                         [3,6,9].includes(an) ? 'position:90% align:right' : 'position:50% align:center';
        return `${line} ${position}`;
    }

    // \pos(x,y) - procentowa konwersja zakładając PlayRes 1920x1080
    const posMatch = rawText.match(/\{[^}]*\\pos\(([0-9.]+),([0-9.]+)\)[^}]*\}/);
    if (posMatch) {
        const xPct = Math.round(parseFloat(posMatch[1]) / 1920 * 100);
        const yPct = Math.round(parseFloat(posMatch[2]) / 1080 * 100);
        const align = xPct < 33 ? 'align:left' : xPct > 66 ? 'align:right' : 'align:center';
        return `line:${yPct}% position:${xPct}% ${align}`;
    }

    return null; // domyślna pozycja (dół-centrum)
}

/**
 * Zamienia timestamp VTT na milisekundy (do porównań)
 */
function vttToMs(vtt) {
    const m = vtt.match(/^(\d+):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!m) return 0;
    return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]);
}

/**
 * Zamienia timestamp ASS (H:MM:SS.CS) na VTT (HH:MM:SS.mmm)
 */
function assTimestampToVtt(ts) {
    const m = ts.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
    if (!m) return null;
    const ms = (parseInt(m[4], 10) * 10).toString().padStart(3, '0');
    return `${m[1].padStart(2,'0')}:${m[2]}:${m[3]}.${ms}`;
}

/**
 * Usuwa tagi formatowania ASS z tekstu dialogu
 */
function stripAssTags(text) {
    return text
        .replace(/\{[^}]*\}/g, '')   // usuń wszystkie {tagi}
        .replace(/\\N/g, '\n')        // \N -> nowa linia
        .replace(/\\n/g, '\n')        // \n -> nowa linia
        .replace(/\\h/g, '\u00A0')    // \h -> niełamliwa spacja
        .replace(/\n{3,}/g, '\n\n')   // max 2 kolejne newlines
        .trim();
}

async function handleDownload(req, res) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const q = Object.fromEntries(url.searchParams);
    const { id, hash, query, type, format } = q;
    const extHint = (q._ext || format || '').toLowerCase();

    console.log(`[Download] id=${id}, hash=${hash}, format=${format}`);

    if (!id || !hash) {
        res.status(400).end('Missing parameters');
        return;
    }

    try {
        const downloadSession = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pl,en;q=0.9',
                'Accept-Charset': 'ISO-8859-2,utf-8;q=0.7,*;q=0.3',
            },
            timeout: 8000, // 8s - mieści się w limicie Vercel Free (10s)
            responseType: 'arraybuffer',
            withCredentials: true,
        });

        const searchParams = new URLSearchParams({ szukane: query || 'test', pTitle: type || 'org', pSortuj: 'pobrn' });
        const searchUrl = `${SEARCH_URL}?${searchParams.toString()}`;
        const searchResponse = await downloadSession.get(searchUrl);
        const cookies = searchResponse.headers['set-cookie'] || [];
        const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
        const searchHtml = iconv.decode(Buffer.from(searchResponse.data), 'ISO-8859-2');

        const $ = cheerio.load(searchHtml);
        let freshHash = null;
        $('form[method="POST"][action="sciagnij.php"]').each((i, form) => {
            const formId = $(form).find('input[name="id"]').val();
            if (formId === id || formId === String(id)) {
                freshHash = $(form).find('input[name="sh"]').val();
            }
        });
        if (!freshHash) freshHash = hash;

        const downloadResponse = await downloadSession.post(
            DOWNLOAD_URL,
            new URLSearchParams({ id, sh: freshHash, single_file: 'Pobierz napisy' }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': searchUrl,
                    'Origin': BASE_URL,
                    'Cookie': cookieString,
                },
                responseType: 'arraybuffer'
            }
        );

        let subtitleContent = Buffer.from(downloadResponse.data);
        const rawText = subtitleContent.toString('latin1');
        if (rawText.includes('zabezpiecze') || rawText.includes('Błąd') || rawText.includes('B³±d')) {
            throw new Error('Błąd zabezpieczeń animesub.info - hash nieważny');
        }

        let subtitleExtension = '.srt';
        if (['ass', 'ssa', 'srt', 'txt', 'sub', 'vtt'].includes(extHint)) {
            subtitleExtension = '.' + extHint;
        }

        // Rozpakowywanie ZIP (bez 7z - tylko AdmZip dla Vercel)
        if (subtitleContent.length > 2 && subtitleContent[0] === 0x50 && subtitleContent[1] === 0x4B) {
            console.log('[Download] Wykryto ZIP, rozpakowuję...');
            let extractedSuccessfully = false;
            try {
                const zip = new AdmZip(subtitleContent);
                const subtitleEntry = zip.getEntries().find(e => !e.isDirectory && /\.(txt|srt|ass|ssa|sub)$/i.test(e.entryName));
                if (subtitleEntry) {
                    const data = subtitleEntry.getData();
                    if (data && data.length > 0) {
                        subtitleContent = data;
                        subtitleExtension = require('path').extname(subtitleEntry.entryName).toLowerCase();
                        extractedSuccessfully = true;
                        console.log('[AdmZip] ✓ Rozpakowano');
                    }
                }
            } catch (e) {
                console.log(`[AdmZip] Błąd: ${e.message}`);
            }
            if (!extractedSuccessfully) {
                throw new Error('Nie udało się rozpakować archiwum (7z niedostępny na Vercel)');
            }
        }

        const decoded = decodeSubtitleBuffer(subtitleContent);
        let textContent = decoded.text;

        if (subtitleExtension === '.ass' || subtitleExtension === '.ssa') {
            textContent = textContent.replace(/^\uFEFF/, '').replace(/\u0000/g, '').replace(/\r/g, '');
            textContent = validateAndFixASS(textContent);
            textContent = fixDialogueTimestamps(textContent);
        } else if (subtitleExtension === '.srt') {
            textContent = textContent.replace(/\r?\n/g, '\r\n');
        }

        // Konwersja ASS/SSA -> VTT jeśli zażądano
        const convertToVtt = q.convert === 'vtt' && (subtitleExtension === '.ass' || subtitleExtension === '.ssa');
        if (convertToVtt) {
            console.log('[Download] Konwertuję ASS -> VTT');
            textContent = assToVtt(textContent);
            subtitleExtension = '.vtt';
        }

        let contentType = 'text/plain; charset=utf-8';
        if (subtitleExtension === '.vtt') contentType = 'text/vtt; charset=utf-8';

        const outBuf = toUtf8Buffer(textContent, subtitleExtension !== '.ass' && subtitleExtension !== '.ssa');
        const filename = `subtitle${subtitleExtension}`;

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', outBuf.length);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, X-Requested-With');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Accept-Ranges', 'bytes');
        res.status(200).end(outBuf);
        console.log(`[Download] ✓ Wysłano ${outBuf.length} bajtów`);

    } catch (error) {
        console.error('[Download Error]', error.message);
        res.status(500).end(`Download failed: ${error.message}`);
    }
}

module.exports = {
    getBaseUrl,
    getMetaInfo,
    searchSubtitles,
    generateSearchStrategies,
    matchSubtitles,
    createSubtitleUrl,
    handleDownload,
    assToVtt,
    SEARCH_URL,
    DOWNLOAD_URL,
    BASE_URL
};
