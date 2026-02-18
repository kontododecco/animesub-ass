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
    // Parsowanie ID
    const parts = id.split(':');
    const prefix = parts[0];
    
    let season = null;
    let episode = null;
    let title = null;
    let year = null;

    // Sprawdź czy to Kitsu czy IMDB
    if (prefix === 'kitsu') {
        // Format Kitsu: kitsu:ANIME_ID:EPISODE
        const kitsuId = parts[1];
        episode = parts.length >= 3 ? parseInt(parts[2], 10) : null;
        
        // Kitsu nie ma sezonów w ten sam sposób - zazwyczaj każdy sezon to osobne anime
        season = 1;

        try {
            // Pobierz dane z Kitsu API
            const kitsuUrl = `https://kitsu.io/api/edge/anime/${kitsuId}`;
            const response = await axios.get(kitsuUrl, {
                headers: {
                    'Accept': 'application/vnd.api+json',
                    'Content-Type': 'application/vnd.api+json'
                },
                timeout: 10000
            });
            
            const anime = response.data.data.attributes;
            // Preferuj tytuł angielski, potem romaji, potem kanoniczny
            title = anime.titles?.en || anime.titles?.en_jp || anime.canonicalTitle || anime.titles?.ja_jp;
            year = anime.startDate ? parseInt(anime.startDate.substring(0, 4), 10) : null;
            
            console.log(`[Kitsu] Pobrano: "${title}" (${year})`);
        } catch (error) {
            console.error('[Kitsu] Błąd pobierania metadanych:', error.message);
        }
        
        return { title, year, season, episode, kitsuId };
        
    } else {
        // Format IMDB: tt1234567 lub tt1234567:1:2
        const imdbId = parts[0];
        
        if (type === 'series' && parts.length >= 3) {
            season = parseInt(parts[1], 10);
            episode = parseInt(parts[2], 10);
        }

        // Próba pobrania tytułu z Cinemeta (z retry i wyższym timeoutem)
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

        // Dekodowanie ISO-8859-2
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

            // Wiersz 1: tytuł oryginalny, data, format
            const row1Cells = $(rows[0]).find('td');
            const titleOrg = $(row1Cells[0]).text().trim();
            const formatType = $(row1Cells[3]).text().trim();

            // Wiersz 2: tytuł angielski, autor, rozmiar
            const row2Cells = $(rows[1]).find('td');
            const titleEng = $(row2Cells[0]).text().trim();
            const author = $(row2Cells[1]).find('a').text().trim() || $(row2Cells[1]).text().trim().replace(/^~/, '');

            // Wiersz 3: tytuł alternatywny, liczba pobrań
            const row3Cells = $(rows[2]).find('td');
            const titleAlt = $(row3Cells[0]).text().trim();
            let downloadCount = 0;
            if (row3Cells.length > 3) {
                const countText = $(row3Cells[3]).text().trim();
                downloadCount = parseInt(countText.split(' ')[0], 10) || 0;
            }

            // Formularz pobierania
            const downloadRow = $(table).find('tr.KKom');
            const form = downloadRow.find('form[method="POST"]');
            const subtitleId = form.find('input[name="id"]').val();
            const downloadHash = form.find('input[name="sh"]').val();

            // Opis (pole Synchro)
            const description = downloadRow.find('td.KNap[align="left"]').text().trim();

            if (!subtitleId || !downloadHash) return;

            // Parsowanie numeru odcinka z tytułów
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
        // Szukanie numeru odcinka: ep01, ep1, episode 01
        if (episode === null) {
            const epMatch = title.match(/(?:ep|episode)\s*(\d+)/i);
            if (epMatch) {
                episode = parseInt(epMatch[1], 10);
            }
        }

        // Szukanie sezonu: Season 3, S3, 2nd Season
        if (season === null) {
            const seasonMatch = title.match(/(?:Season|S)\s*(\d+)|(\d+)(?:nd|rd|th)\s+Season/i);
            if (seasonMatch) {
                season = parseInt(seasonMatch[1] || seasonMatch[2], 10);
            }
        }

        // Sezon implicit: "Title 2 ep01" -> sezon 2
        if (season === null && episode !== null) {
            const implicitMatch = title.match(/\s(\d)\s+ep\d+/i);
            if (implicitMatch) {
                season = parseInt(implicitMatch[1], 10);
            }
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

        // Strategia 1: Tytuł z sezonem i odcinkiem (dla sezonów > 1)
        if (season && season > 1) {
            strategies.push({ type: 'en', query: `${cleanTitle} Season ${season} ep${epStr}` });
            strategies.push({ type: 'en', query: `${cleanTitle} ${season} ep${epStr}` });
            strategies.push({ type: 'en', query: `${cleanTitle} S${season} ep${epStr}` });
        }

        // Strategia 2: Tytuł z odcinkiem
        strategies.push({ type: 'org', query: `${cleanTitle} ep${epStr}` });
        strategies.push({ type: 'en', query: `${cleanTitle} ep${epStr}` });

        // Strategia 3: Szersze wyszukiwanie z sezonem
        if (season && season > 1) {
            strategies.push({ type: 'en', query: `${cleanTitle} Season ${season}` });
            strategies.push({ type: 'en', query: `${cleanTitle} ${season}` });
        }
    }

    // Strategia 4: Tylko tytuł (ostateczność)
    strategies.push({ type: 'org', query: cleanTitle });
    strategies.push({ type: 'en', query: cleanTitle });

    return strategies;
}

/**
 * Dopasowuje napisy do żądanego odcinka
 */
function matchSubtitles(subtitles, targetSeason, targetEpisode) {
    return subtitles.filter(sub => {
        // Filtrowanie po odcinku
        if (targetEpisode !== null && sub.episode !== null) {
            if (sub.episode !== targetEpisode) return false;
        }

        // Filtrowanie po sezonie
        if (targetSeason !== null && sub.season !== null) {
            if (sub.season !== targetSeason) return false;
        }

        // Jeśli szukamy sezonu 1, a napis nie ma sezonu - akceptujemy
        if (targetSeason === 1 && sub.season === null) {
            return true;
        }

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

    // KLUCZ: rozszerzenie w PATH, bo VLC/stremio czasem bazuje na nim do wykrycia formatu
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

            // Jeśli znaleźliśmy dokładne dopasowanie odcinka, przerywamy
            const exactMatch = matched.some(s => 
                s.episode === meta.episode && 
                (meta.season === null || meta.season === 1 || s.season === meta.season)
            );
            
            if (exactMatch && matched.length >= 1) {
                console.log('[Znaleziono] Dokładne dopasowanie, przerywam wyszukiwanie');
                break;
            }

            // Wystarczająco dużo wyników
            if (allSubtitles.length >= 5) {
                console.log('[Znaleziono] Wystarczająco wyników, przerywam wyszukiwanie');
                break;
            }
        }

        // Sortowanie: najpierw po liczbie pobrań
        allSubtitles.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));

        // Konwersja do formatu Stremio
        const stremioSubtitles = allSubtitles.slice(0, 10).map(sub => {
            // Określ format na podstawie description lub formatType
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

        console.log(`[Wynik] Zwracam ${stremioSubtitles.length} napisów`);
        return { subtitles: stremioSubtitles };

    } catch (error) {
        console.error('[Błąd]', error);
        return { subtitles: [] };
    }
});

/**
 * Funkcja pomocnicza do rozpakowywania ZIP z obsługą LZMA (używa systemowego 7z)
 * @param {Buffer} zipBuffer Bufor z danymi archiwum ZIP
 * @returns {Promise<{content: Buffer, extension: string}|null>} Rozpakowany plik lub null
 */
async function extractWith7z(zipBuffer) {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    console.log(`[7z] Rozpoczynam ekstrakcję, rozmiar bufora: ${zipBuffer.length} bajtów`);
    
    // Utwórz plik tymczasowy (w pamięci RAM jeśli możliwe)
    const tmpDir = os.tmpdir();
    const tmpZipPath = path.join(tmpDir, `subtitle_${Date.now()}_${Math.random().toString(36).substring(7)}.zip`);
    
    try {
        // Zapisz ZIP do pliku tymczasowego
        fs.writeFileSync(tmpZipPath, zipBuffer);
        console.log(`[7z] Zapisano ZIP do: ${tmpZipPath}`);
        
        // Listuj zawartość ZIP
        console.log(`[7z] Krok 1: Listowanie zawartości...`);
        const listResult = spawnSync('7z', ['l', '-slt', tmpZipPath], {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024
        });
        
        if (listResult.error) {
            throw listResult.error;
        }
        
        // Znajdź nazwę pliku napisów
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
        
        // Rozpakuj do stdout
        console.log(`[7z] Krok 2: Rozpakowywanie ${subtitleFileName}...`);
        const extractResult = spawnSync('7z', ['e', '-so', tmpZipPath, subtitleFileName], {
            maxBuffer: 10 * 1024 * 1024
        });
        
        if (extractResult.error) {
            throw extractResult.error;
        }
        
        if (extractResult.status !== 0) {
            console.error(`[7z] stderr:`, extractResult.stderr?.toString() || 'brak');
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
        // Usuń plik tymczasowy
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
    const oddRatio  = zerosOdd  / pairs;

    // UTF-16LE: dużo zer na pozycjach nieparzystych (A\0B\0C\0)
    if (oddRatio > 0.30 && evenRatio < 0.05) return 'utf-16le';
    // UTF-16BE: dużo zer na pozycjach parzystych (\0A\0B\0C)
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
    // Więcej polskich liter = lepiej, dużo "mojibake" = gorzej, kontrolne = gorzej
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
    // 1) UTF-8 BOM
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return { text: buf.slice(3).toString('utf8'), encoding: 'utf8-bom' };
    }

    // 2) UTF-16 BOM
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return { text: iconv.decode(buf.slice(2), 'utf-16le'), encoding: 'utf16le-bom' };
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        return { text: iconv.decode(buf.slice(2), 'utf-16be'), encoding: 'utf16be-bom' };
    }

    // 3) UTF-16 bez BOM (heurystyka po zerach)
    const utf16 = sniffUtf16NoBom(buf);
    if (utf16) {
        return { text: iconv.decode(buf, utf16), encoding: utf16 };
    }

    // 4) Strict UTF-8 (bez zgadywania po "")
    const utf8 = tryDecodeUtf8Strict(buf);
    if (utf8 !== null) {
        return { text: utf8, encoding: 'utf8' };
    }

    // 5) Fallback: windows-1250 vs ISO-8859-2 (wybierz bardziej "polskie")
    const c1 = { enc: 'windows-1250', text: iconv.decode(buf, 'windows-1250') };
    const c2 = { enc: 'ISO-8859-2',  text: iconv.decode(buf, 'ISO-8859-2')  };

    const s1 = scorePolishText(c1.text);
    const s2 = scorePolishText(c2.text);

    return (s1 >= s2)
        ? { text: c1.text, encoding: c1.enc }
        : { text: c2.text, encoding: c2.enc };
}

function toUtf8BufferWithBom(text) {
    // Usuń NUL-e (czasem zostają po złych plikach)
    const cleaned = (text || '').replace(/\u0000/g, '');
    // BOM na start – pomaga VLC/Stremio nie zgadywać kodowania
    return Buffer.from('\uFEFF' + cleaned, 'utf8');
}

// Pobieranie napisów (endpoint proxy)
async function downloadSubtitle(req, res) {
    // Logika wyciągania query z req.query lub url.searchParams
    const q = req.query || {};
    const { id, hash, query, type, format } = q;
    const extHint = (q._ext || format || '').toLowerCase();

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
        const rawText = subtitleContent.toString('latin1');
        if (rawText.includes('zabezpiecze') || rawText.includes('Błąd') || rawText.includes('B³±d')) {
            throw new Error('Błąd zabezpieczeń animesub.info - hash nieważny');
        }

        let subtitleExtension = '.srt';
        if (['ass', 'ssa', 'srt', 'txt', 'sub', 'vtt'].includes(extHint)) {
            subtitleExtension = '.' + extHint;
        }

        if (subtitleContent.length > 2 && subtitleContent[0] === 0x50 && subtitleContent[1] === 0x4B) {
            console.log('[Download] Wykryto ZIP...');
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
                    }
                }
            } catch (e) { console.log(`[AdmZip] Błąd: ${e.message}`); }

            if (!extractedSuccessfully) {
                try {
                    const result = await extractWith7z(subtitleContent);
                    if (result) {
                        subtitleContent = result.content;
                        subtitleExtension = result.extension || '.srt';
                        extractedSuccessfully = true;
                    }
                } catch (e) { console.log(`[7z] Błąd: ${e.message}`); }
            }
        }

        const decoded = decodeSubtitleBuffer(subtitleContent);
        let textContent = decoded.text;
        if (subtitleExtension === '.srt') textContent = textContent.replace(/\r?\n/g, '\r\n');

        let contentType = 'text/plain; charset=utf-8';
        if (subtitleExtension === '.ass' || subtitleExtension === '.ssa') contentType = 'application/octet-stream';
        else if (subtitleExtension === '.srt') contentType = 'application/x-subrip; charset=utf-8';

        const outBuf = toUtf8BufferWithBom(textContent);
        const filename = `subtitle${subtitleExtension}`;

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': outBuf.length,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, X-Requested-With',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
            'Content-Disposition': `inline; filename="${filename}"; filename*=UTF-8''${filename}`,
            'Cache-Control': 'public, max-age=3600'
        });
        res.end(outBuf);

    } catch (error) {
        console.error('[Download Error]', error.message);
        res.writeHead(500);
        res.end('Download failed');
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
    const spaceId = process.env.SPACE_ID;
    const parts = spaceId.split('/');
    if (parts.length === 2) {
        BASE_URL_RESOLVED = `https://${parts[0]}-${parts[1].replace(/_/g, '-')}.hf.space`;
    }
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range' });
        res.end();
        return;
    }

    if (url.pathname === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(manifest));
    } else if (url.pathname.startsWith('/subtitles/download')) {
        req.query = Object.fromEntries(url.searchParams);
        downloadSubtitle(req, res);
    } else {
        const router = getRouter(builder.getInterface());
        router(req, res, () => {
            res.writeHead(404);
            res.end();
        });
    }
});

server.listen(PORT, () => {
    console.log(`Addon serwer działa na porcie ${PORT}`);
    console.log(`Manifest dostępny pod: ${BASE_URL_RESOLVED}/manifest.json`);
});