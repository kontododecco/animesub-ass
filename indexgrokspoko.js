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
    version: '1.0.0',
    name: 'AnimeSub.info Subtitles',
    description: 'Polskie napisy do anime z animesub.info',
    logo: 'https://i.imgur.com/qKLYVZx.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
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
                timeout: 5000
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
        try {
            const metaUrl = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
            const response = await axios.get(metaUrl, { timeout: 5000 });
            const meta = response.data.meta;
            return {
                title: meta.name,
                year: meta.year,
                season,
                episode,
                imdbId
            };
        } catch (error) {
            console.error('Błąd pobierania metadanych z Cinemeta:', error.message);
            return { imdbId, season, episode, title: null, year: null };
        }
    }
}

/**
 * Wyszukuje napisy na animesub.info
 */
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

/**
 * Parsuje wyniki wyszukiwania HTML
 */
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

/**
 * Parsuje informacje o odcinku z tytułów
 */
function parseEpisodeInfo(titleOrg, titleEng, titleAlt) {
    let season = null;
    let episode = null;
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
    }
    return { season, episode };
}

/**
 * Generuje strategie wyszukiwania dla tytułu
 */
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

/**
 * Dopasowuje napisy do żądanego odcinka
 */
function matchSubtitles(subtitles, targetSeason, targetEpisode) {
    return subtitles.filter(sub => {
        if (targetEpisode !== null && sub.episode !== null) {
            if (sub.episode !== targetEpisode) return false;
        }
        if (targetSeason !== null && sub.season !== null) {
            if (sub.season !== targetSeason) return false;
        }
        if (targetSeason === 1 && sub.season === null) return true;
        return true;
    });
}

/**
 * Tworzy URL do napisów (proxy przez nasz serwer)
 */
function createSubtitleUrl(subtitle, searchQuery, searchType, format = 'srt') {
    const params = new URLSearchParams({
        id: subtitle.id,
        hash: subtitle.hash,
        query: searchQuery,
        type: searchType,
        format
    });
    return `${BASE_URL_RESOLVED}/subtitles/download.${format}?${params.toString()}`;
}

/**
 * Handler napisów Stremio
 */
builder.defineSubtitlesHandler(async ({ type, id }) => {
    console.log(`\n[Request] type=${type}, id=${id}`);
    try {
        const meta = await getMetaInfo(type, id);
        console.log(`[Meta] title="${meta.title}", season=${meta.season}, episode=${meta.episode}`);
        if (!meta.title) {
            console.log('[Błąd] Nie udało się pobrać tytułu');
            return { subtitles: [] };
        }
        const strategies = generateSearchStrategies(meta.title, meta.season, meta.episode);
        let allSubtitles = [];
        const seenIds = new Set();
        for (const strategy of strategies) {
            console.log(`[Strategia] "${strategy.query}" (${strategy.type})`);
           
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
            const exactMatch = matched.some(s =>
                s.episode === meta.episode &&
                (meta.season === null || meta.season === 1 || s.season === meta.season)
            );
           
            if (exactMatch && matched.length >= 1) {
                console.log('[Znaleziono] Dokładne dopasowanie, przerywam wyszukiwanie');
                break;
            }
            if (allSubtitles.length >= 5) {
                console.log('[Znaleziono] Wystarczająco wyników, przerywam wyszukiwanie');
                break;
            }
        }
        allSubtitles.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));
        const stremioSubtitles = allSubtitles.slice(0, 10).map(sub => {
            let format = 'srt';
            if (sub.description && sub.description.toLowerCase().includes('.ass')) {
                format = 'ass';
            } else if (sub.description && sub.description.toLowerCase().includes('.ssa')) {
                format = 'ssa';
            } else if (sub.formatType && sub.formatType.toLowerCase().includes('ass')) {
                format = 'ass';
            }
           
            const label = [
                sub.titleEng || sub.titleOrg,
                sub.author ? `by ${sub.author}` : null,
                `[${format}]`,
                sub.downloadCount ? `${sub.downloadCount} pobrań` : null
            ].filter(Boolean).join(' | ');
            return {
                id: `animesub-${sub.id}`,
                url: createSubtitleUrl(sub, sub.searchQuery, sub.searchType, format),
                lang: 'pol',
                SubtitleName: label
            };
        });
        console.log(`[Wynik] Zwracam ${stremioSubtitles.length} napisów`);
        return { subtitles: stremioSubtitles };
    } catch (error) {
        console.error('[Błąd]', error);
        return { subtitles: [] };
    }
});

/**
 * Funkcja pomocnicza do rozpakowywania ZIP z obsługą LZMA (używa systemowego 7z)
 */
async function extractWith7z(zipBuffer) {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
   
    console.log(`[7z] Rozpoczynam ekstrakcję, rozmiar bufora: ${zipBuffer.length} bajtów`);
   
    const tmpDir = os.tmpdir();
    const tmpZipPath = path.join(tmpDir, `subtitle_${Date.now()}_${Math.random().toString(36).substring(7)}.zip`);
   
    try {
        fs.writeFileSync(tmpZipPath, zipBuffer);
        console.log(`[7z] Zapisano ZIP do: ${tmpZipPath}`);
       
        const listResult = spawnSync('7z', ['l', '-slt', tmpZipPath], {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024
        });
       
        if (listResult.error) throw listResult.error;
       
        const lines = listResult.stdout.split('\n');
        let subtitleFileName = null;
       
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('Path = ')) {
                const fileName = lines[i].substring(7).trim();
                if (/\.(txt|srt|ass|ssa|sub)$/i.test(fileName)) {
                    subtitleFileName = fileName;
                    console.log(`[7z] Znaleziono plik: ${subtitleFileName}`);
                    break;
                }
            }
        }
       
        if (!subtitleFileName) {
            console.log(`[7z] Nie znaleziono pliku napisów w archiwum`);
            return null;
        }
       
        const extractResult = spawnSync('7z', ['e', '-so', tmpZipPath, subtitleFileName], {
            maxBuffer: 10 * 1024 * 1024
        });
       
        if (extractResult.error) throw extractResult.error;
        if (extractResult.status !== 0) {
            throw new Error(`7z exit code: ${extractResult.status}`);
        }
       
        const content = extractResult.stdout;
        console.log(`[7z] ✓ Rozpakowano ${content.length} bajtów`);
       
        const extension = path.extname(subtitleFileName).toLowerCase();
       
        return { content, extension };
       
    } catch (error) {
        console.error(`[7z] BŁĄD:`, error.message);
        throw new Error(`7z extraction failed: ${error.message}`);
    } finally {
        try {
            if (fs.existsSync(tmpZipPath)) {
                fs.unlinkSync(tmpZipPath);
                console.log(`[7z] Usunięto plik tymczasowy`);
            }
        } catch (cleanupError) {
            console.error(`[7z] Nie udało się usunąć pliku tymczasowego:`, cleanupError.message);
        }
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
    const ctrl = t.match(/[-\u0008\u000B\u000C\u000E-\u001F]/g);
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
    if (utf16) {
        return { text: iconv.decode(buf, utf16), encoding: utf16 };
    }
    const utf8 = tryDecodeUtf8Strict(buf);
    if (utf8 !== null) {
        return { text: utf8, encoding: 'utf8' };
    }
    const c1 = { enc: 'windows-1250', text: iconv.decode(buf, 'windows-1250') };
    const c2 = { enc: 'ISO-8859-2', text: iconv.decode(buf, 'ISO-8859-2') };
    const s1 = scorePolishText(c1.text);
    const s2 = scorePolishText(c2.text);
    return (s1 >= s2)
        ? { text: c1.text, encoding: c1.enc }
        : { text: c2.text, encoding: c2.enc };
}

function toUtf8BufferWithBom(text) {
    const cleaned = (text || '').replace(/\0/g, '');
    return Buffer.from('\uFEFF' + cleaned, 'utf8');
}

/**
 * Usuwa WSZYSTKIE tagi {} z pola tekstu w liniach Dialogue
 * i wstawia na samym początku tekstu stały blok stylu czcionki/pozycji/koloru
 * Pole Style pozostaje bez zmian (oryginalne)
 */
function cleanTagsAndAddFixedStyle(assContent) {
    const FIXED_STYLE_TAG = '{\\fs48\\fnSpitz Pro Book\\c&HEDEDED&\\b0}';

    return assContent
        .split(/\r?\n/)
        .map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(';') || !trimmed.startsWith('Dialogue:')) {
                return line;
            }

            // Znajdujemy początek pola tekstu (po 9. przecinku)
            let commaCount = 0;
            let textStart = -1;
            for (let i = 0; i < line.length; i++) {
                if (line[i] === ',') {
                    commaCount++;
                    if (commaCount === 9) {
                        textStart = i + 1;
                        break;
                    }
                }
            }

            if (textStart === -1) return line;

            const prefix = line.slice(0, textStart);        // wszystko do pola tekstu włącznie
            let text = line.slice(textStart);               // samo pole tekstu

            // Usuwamy wszystkie tagi {...}
            text = text.replace(/\{[^}]*\}/g, '').trimStart();

            // Wstawiamy tylko tag stylu (bez "OddTaxi - Znaki,,0,0,0,,")
            const newText = FIXED_STYLE_TAG + text;

            return prefix + newText;
        })
        .join('\n');
}

// Pobieranie napisów (endpoint proxy)
async function downloadSubtitle(req, res) {
    const extHint = (req.query?._ext || req.query?.format || '').toLowerCase();
    const { id, hash, query, type } = req.query || req.url.searchParams || {};
    console.log(`[Download] id=${id}, hash=${hash}, query=${query}`);
    if (!id || !hash) {
        res.writeHead(400);
        res.end('Missing parameters');
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
            timeout: 15000,
            responseType: 'arraybuffer',
            withCredentials: true,
        });

        const searchParams = new URLSearchParams({
            szukane: query || 'test',
            pTitle: type || 'org',
            pSortuj: 'pobrn'
        });
        const searchUrl = `${SEARCH_URL}?${searchParams.toString()}`;
        console.log(`[Download] Krok 1: Pobieram stronę wyszukiwania`);
       
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
                console.log(`[Download] ✓ Znaleziono świeży hash dla id=${id}`);
            }
        });
        if (!freshHash) {
            console.log(`[Download] ✗ Nie znaleziono formularza dla id=${id}, używam oryginalnego hasha`);
            freshHash = hash;
        }

        console.log(`[Download] Krok 2: Pobieram napisy`);
       
        const downloadResponse = await downloadSession.post(DOWNLOAD_URL,
            new URLSearchParams({
                id: id,
                sh: freshHash,
                single_file: 'Pobierz napisy'
            }).toString(),
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
        console.log(`[Download] Pobrano ${subtitleContent.length} bajtów`);

        const rawText = subtitleContent.toString('latin1');
        if (rawText.includes('zabezpiecze') || rawText.includes('Błąd') || rawText.includes('B³±d')) {
            console.log(`[Download] ✗ BŁĄD ZABEZPIECZEŃ!`);
            throw new Error('Błąd zabezpieczeń animesub.info - hash nieważny');
        }

        let subtitleExtension = '.srt';
        if (['ass', 'ssa', 'srt', 'txt', 'sub', 'vtt'].includes(extHint)) {
            subtitleExtension = '.' + extHint;
        }

        if (subtitleContent.length > 2 && subtitleContent[0] === 0x50 && subtitleContent[1] === 0x4B) {
            console.log('[Download] Wykryto archiwum ZIP, rozpakowuję...');
            let extractedSuccessfully = false;

            try {
                const zip = new AdmZip(subtitleContent);
                const entries = zip.getEntries();
                console.log(`[Download] Pliki w archiwum: ${entries.map(e => e.entryName).join(', ')}`);
               
                const subtitleEntry = entries.find(e =>
                    !e.isDirectory && /\.(txt|srt|ass|ssa|sub)$/i.test(e.entryName)
                );
                if (subtitleEntry) {
                    const data = subtitleEntry.getData();
                    if (data && data.length > 0) {
                        subtitleContent = data;
                        subtitleExtension = require('path').extname(subtitleEntry.entryName).toLowerCase();
                        console.log(`[AdmZip] ✓ Rozpakowano: ${subtitleEntry.entryName} (${subtitleContent.length} bajtów)`);
                        extractedSuccessfully = true;

                        if (subtitleExtension === '.txt') {
                            const preview = subtitleContent.slice(0, 200).toString('utf-8');
                            if (preview.includes('[Script Info]') || preview.includes('Dialogue:')) {
                                subtitleExtension = '.ass';
                            }
                        }
                    }
                }
            } catch (admZipError) {
                console.error(`[AdmZip] ✗ Błąd: ${admZipError.message}`);
            }

            if (!extractedSuccessfully) {
                console.log('[Download] AdmZip zawiódł, próbuję 7z...');
                try {
                    const result = await extractWith7z(subtitleContent);
                    if (result && result.content && result.content.length > 0) {
                        subtitleContent = result.content;
                        subtitleExtension = result.extension || '.srt';
                        console.log(`[7z] ✓ Rozpakowano (${subtitleContent.length} bajtów)`);
                        extractedSuccessfully = true;

                        if (subtitleExtension === '.txt') {
                            const preview = subtitleContent.slice(0, 200).toString('utf-8');
                            if (preview.includes('[Script Info]') || preview.includes('Dialogue:')) {
                                subtitleExtension = '.ass';
                            }
                        }
                    }
                } catch (sevenZipError) {
                    console.error(`[7z] ✗ Błąd: ${sevenZipError.message}`);
                }
            }

            if (!extractedSuccessfully) {
                console.log('[Download] ✗ Nie udało się rozpakować ZIP');
                res.writeHead(500, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end('Nie udało się rozpakować archiwum ZIP (nieobsługiwana kompresja)');
                return;
            }
        } else {
            const firstBytes = subtitleContent.slice(0, 200);
            try {
                const preview = firstBytes.toString('utf-8');
                if (preview.includes('[Script Info]') || preview.includes('[V4+ Styles]') || preview.includes('Dialogue:')) {
                    subtitleExtension = '.ass';
                    console.log('[Download] Wykryto format ASS/SSA');
                } else if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(preview)) {
                    subtitleExtension = '.srt';
                    console.log('[Download] Wykryto format SRT');
                }
            } catch (e) {
                console.log('[Download] Nie można określić formatu, domyślnie SRT');
            }
        }

        const decoded = decodeSubtitleBuffer(subtitleContent);
        let textContent = decoded.text;

        // <-- NORMALIZACJA STYLU DLA ASS/SSA -->
        if (subtitleExtension === '.ass' || subtitleExtension === '.ssa') {
            console.log('[Post-process] Normalizacja do stylu OddTaxi - Znaki');
            textContent = cleanTagsAndAddFixedStyle(textContent);
        }

        if (subtitleExtension === '.srt') {
            textContent = textContent.replace(/\r?\n/g, '\r\n');
        }

        console.log(`[Download] Wykryte kodowanie: ${decoded.encoding}`);
        console.log(`[Download] ✓ Wysyłam napisy (${textContent.length} znaków, format: ${subtitleExtension})`);

        let contentType = 'text/plain; charset=utf-8';
        if (subtitleExtension === '.ass' || subtitleExtension === '.ssa') {
            contentType = 'text/x-ssa; charset=utf-8';
        } else if (subtitleExtension === '.srt') {
            contentType = 'application/x-subrip; charset=utf-8';
        } else if (subtitleExtension === '.vtt') {
            contentType = 'text/vtt; charset=utf-8';
        }

        const outBuf = toUtf8BufferWithBom(textContent);
        const filename = `subtitle${subtitleExtension}`;

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': outBuf.length,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Disposition': `inline; filename="${filename}"; filename*=UTF-8''${filename}`,
            'Cache-Control': 'public, max-age=3600'
        });

        res.end(outBuf);
    } catch (error) {
        console.error('[Download Error]', error.message);
        res.writeHead(500);
        res.end('Download failed: ' + error.message);
    }
}

// Uruchomienie serwera
const PORT = process.env.PORT || 7000;
const http = require('http');

if (process.env.BASE_URL) {
    BASE_URL_RESOLVED = process.env.BASE_URL;
} else if (process.env.SPACE_HOST) {
    BASE_URL_RESOLVED = `https://${process.env.SPACE_HOST}`;
} else if (process.env.SPACE_ID) {
    const spaceId = process.env.SPACE_ID.replace('/', '-').toLowerCase();
    BASE_URL_RESOLVED = `https://${spaceId}.hf.space`;
} else {
    BASE_URL_RESOLVED = `http://localhost:${PORT}`;
}

console.log(`[Config] BASE_URL: ${BASE_URL_RESOLVED}`);

const addonInterface = builder.getInterface();
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
   
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
    }
   
    if (url.pathname.startsWith('/subtitles/download')) {
        req.query = Object.fromEntries(url.searchParams);
        const m = url.pathname.match(/\/subtitles\/download\.([a-z0-9]+)$/i);
        if (m) req.query._ext = m[1].toLowerCase();
        downloadSubtitle(req, res);
        return;
    }
   
    const addonRouter = getRouter(addonInterface);
    addonRouter(req, res, () => {
        res.writeHead(404);
        res.end('Not found');
    });
});

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║ AnimeSub.info Stremio Addon                                ║
╠════════════════════════════════════════════════════════════╣
║ Serwer uruchomiony na: http://localhost:${PORT}            ║
║                                                            ║
║ Link do instalacji w Stremio:                              ║
║ ${BASE_URL_RESOLVED}/manifest.json                         ║
║                                                            ║
║ Aby zainstalować:                                          ║
║ 1. Otwórz Stremio                                          ║
║ 2. Idź do Addons → Community Addons                        ║
║ 3. Wklej powyższy link w pole "Addon Repository URL"       ║
╚════════════════════════════════════════════════════════════╝
`);
});