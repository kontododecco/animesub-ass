const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const { TextDecoder } = require('util');

// Dodaje {\an2} tylko do linii Dialogue bez istniejącego pozycjonowania
function forceAn2(assText) {
    if (!assText.includes('[Script Info]')) return assText; // nie ASS → nie ruszamy

    const lines = assText.split(/\r?\n/);
    const out = [];

    // Wykrywa już istniejące pozycjonowanie
    const hasPos = /\\an[1-9]|\\pos\(|\\move\(/i;

    for (const line of lines) {
        if (!line.startsWith('Dialogue:')) {
            out.push(line);
            continue;
        }

        if (hasPos.test(line)) {
            out.push(line);
            continue;
        }

        // Rozbijamy linię bezpiecznie (ostatnie pole = Text)
        const match = line.match(/^([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,)(.*)$/);
        if (!match) {
            out.push(line);
            continue;
        }

        const prefix = match[1];
        let text = match[2];

        // Wstawiamy {\an2} na samym początku pola Text
        text = '{\\an2}' + text;

        out.push(prefix + text);
    }

    return out.join('\n');
}

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
        configurationRequired: false,
        adult: false
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
    try {
        if (id.startsWith('tt')) {
            // IMDB ID
            const response = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, {
                timeout: 5000
            });
            return response.data.meta;
        } else if (id.startsWith('kitsu:')) {
            // Kitsu ID
            const kitsuId = id.replace('kitsu:', '');
            const response = await axios.get(`https://anime-kitsu.strem.fun/meta/${type}/${kitsuId}.json`, {
                timeout: 5000
            });
            return response.data.meta;
        }
    } catch (error) {
        console.error(`[Meta] Błąd pobierania metadanych dla ${id}:`, error.message);
    }
    return null;
}

/**
 * Wyszukuje napisy na animesub.info
 */
async function searchSubtitles(title, titleType = 'en') {
    const cacheKey = `${title}_${titleType}`;
    
    // Sprawdź cache
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`[Cache] Zwracam wyniki z cache dla: ${title}`);
        return cached.results;
    }

    try {
        console.log(`[Search] Szukam napisów dla: "${title}" (typ: ${titleType})`);
        
        const params = new URLSearchParams({
            szukane: title,
            pTitle: titleType,
            pSortuj: 'pobrn'
        });

        const response = await session.get(`${SEARCH_URL}?${params.toString()}`);
        const html = iconv.decode(Buffer.from(response.data), 'ISO-8859-2');
        
        const results = parseSearchResults(html);
        
        // Zapisz do cache
        searchCache.set(cacheKey, {
            results,
            timestamp: Date.now()
        });

        console.log(`[Search] Znaleziono ${results.length} wyników`);
        return results;
    } catch (error) {
        console.error(`[Search] Błąd wyszukiwania:`, error.message);
        return [];
    }
}

/**
 * Parsuje wyniki wyszukiwania HTML
 */
function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const results = [];

    $('form[method="POST"][action="sciagnij.php"]').each((i, form) => {
        const $form = $(form);
        const id = $form.find('input[name="id"]').val();
        const hash = $form.find('input[name="sh"]').val();
        
        const $parent = $form.parent();
        const titleOrg = $parent.find('td:nth-child(2)').text().trim();
        const titleEng = $parent.find('td:nth-child(3)').text().trim();
        const titleAlt = $parent.find('td:nth-child(4)').text().trim();
        const downloads = parseInt($parent.find('td:nth-child(5)').text().trim()) || 0;

        if (id && hash) {
            const episodeInfo = parseEpisodeInfo(titleOrg, titleEng, titleAlt);
            
            results.push({
                id,
                hash,
                titleOrg,
                titleEng,
                titleAlt,
                downloads,
                ...episodeInfo
            });
        }
    });

    return results;
}

/**
 * Parsuje informacje o odcinku z tytułów
 */
function parseEpisodeInfo(titleOrg, titleEng, titleAlt) {
    const patterns = [
        /(?:odcinek|odc\.?|ep\.?|episode)\s*(\d+)/i,
        /\b(\d+)\s*(?:odcinek|odc|ep)/i,
        /\s-\s(\d+)\s*$/,
        /\[(\d+)\]/,
        /E(\d+)/i
    ];

    const seasonPatterns = [
        /(?:sezon|season|s)\s*(\d+)/i,
        /S(\d+)E\d+/i
    ];

    let episode = null;
    let season = null;

    // Szukaj numeru odcinka
    for (const pattern of patterns) {
        const match = titleOrg.match(pattern) || titleEng.match(pattern) || titleAlt.match(pattern);
        if (match) {
            episode = parseInt(match[1]);
            break;
        }
    }

    // Szukaj numeru sezonu
    for (const pattern of seasonPatterns) {
        const match = titleOrg.match(pattern) || titleEng.match(pattern) || titleAlt.match(pattern);
        if (match) {
            season = parseInt(match[1]);
            break;
        }
    }

    return { episode, season };
}

/**
 * Generuje strategie wyszukiwania dla tytułu
 */
function generateSearchStrategies(title, season, episode) {
    const strategies = [];
    
    // Strategia 1: Pełny tytuł
    strategies.push({
        query: title,
        type: 'en',
        weight: 10
    });

    // Strategia 2: Tytuł bez roku
    const titleWithoutYear = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    if (titleWithoutYear !== title) {
        strategies.push({
            query: titleWithoutYear,
            type: 'en',
            weight: 9
        });
    }

    // Strategia 3: Pierwsze słowo (dla długich tytułów)
    const firstWord = title.split(/[\s:-]/)[0];
    if (firstWord.length > 3) {
        strategies.push({
            query: firstWord,
            type: 'en',
            weight: 5
        });
    }

    // Strategia 4: Wyszukiwanie w oryginalnym tytule
    strategies.push({
        query: title,
        type: 'org',
        weight: 8
    });

    return strategies;
}

/**
 * Dopasowuje napisy do żądanego odcinka
 */
function matchSubtitles(subtitles, targetSeason, targetEpisode) {
    return subtitles
        .map(sub => {
            let score = 0;
            
            // Dopasowanie odcinka
            if (targetEpisode && sub.episode === targetEpisode) {
                score += 100;
            } else if (targetEpisode && sub.episode) {
                score -= Math.abs(sub.episode - targetEpisode) * 10;
            }
            
            // Dopasowanie sezonu
            if (targetSeason && sub.season === targetSeason) {
                score += 50;
            } else if (targetSeason && sub.season) {
                score -= Math.abs(sub.season - targetSeason) * 20;
            }
            
            // Bonus za popularność
            score += Math.min(sub.downloads / 100, 10);
            
            return { ...sub, score };
        })
        .filter(sub => sub.score > 0)
        .sort((a, b) => b.score - a.score);
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
        format: format
    });
    
    return `${BASE_URL_RESOLVED}/subtitles/download.${format}?${params.toString()}`;
}

/**
 * Handler napisów Stremio
 */
builder.defineSubtitlesHandler(async ({ type, id }) => {
    console.log(`\n[Handler] Żądanie napisów dla: type=${type}, id=${id}`);
    
    try {
        // Pobierz metadane
        const meta = await getMetaInfo(type, id);
        if (!meta) {
            console.log('[Handler] Brak metadanych');
            return { subtitles: [] };
        }

        console.log(`[Handler] Tytuł: ${meta.name}`);
        
        // Określ sezon i odcinek z ID (np. tt1234567:1:5 = sezon 1, odcinek 5)
        const idParts = id.split(':');
        const season = idParts[1] ? parseInt(idParts[1]) : null;
        const episode = idParts[2] ? parseInt(idParts[2]) : null;

        console.log(`[Handler] Sezon: ${season}, Odcinek: ${episode}`);

        // Generuj strategie wyszukiwania
        const strategies = generateSearchStrategies(meta.name, season, episode);
        
        let allSubtitles = [];
        
        // Wykonaj wyszukiwania
        for (const strategy of strategies) {
            const results = await searchSubtitles(strategy.query, strategy.type);
            allSubtitles.push(...results.map(r => ({ ...r, searchWeight: strategy.weight })));
        }

        // Usuń duplikaty (po ID)
        const uniqueSubtitles = Array.from(
            new Map(allSubtitles.map(s => [s.id, s])).values()
        );

        // Dopasuj do odcinka (jeśli serial)
        let matchedSubtitles = uniqueSubtitles;
        if (episode) {
            matchedSubtitles = matchSubtitles(uniqueSubtitles, season, episode);
        } else {
            // Dla filmów - sortuj po popularności
            matchedSubtitles = uniqueSubtitles.sort((a, b) => b.downloads - a.downloads);
        }

        // Ogranicz do top 10
        const topSubtitles = matchedSubtitles.slice(0, 10);

        console.log(`[Handler] Zwracam ${topSubtitles.length} napisów`);

        // Przygotuj odpowiedź dla Stremio
        const subtitles = topSubtitles.map(sub => {
            const episodeStr = sub.episode ? ` [Odc. ${sub.episode}]` : '';
            const seasonStr = sub.season ? ` [S${sub.season}]` : '';
            
            return {
                id: `animesub-${sub.id}`,
                url: createSubtitleUrl(sub, strategies[0].query, strategies[0].type, 'srt'),
                lang: 'pol',
                label: `Polish${seasonStr}${episodeStr} - ${sub.titleOrg || sub.titleEng}`.substring(0, 100)
            };
        });

        return { subtitles };
        
    } catch (error) {
        console.error('[Handler] Błąd:', error);
        return { subtitles: [] };
    }
});

/**
 * Funkcja pomocnicza do rozpakowywania ZIP z obsługą LZMA (używa systemowego 7z)
 */
async function extractWith7z(zipBuffer) {
    const { exec } = require('child_process');
    const fs = require('fs').promises;
    const path = require('path');
    const os = require('os');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'animesub-'));
    const zipPath = path.join(tmpDir, 'archive.zip');
    
    try {
        await fs.writeFile(zipPath, zipBuffer);
        
        return await new Promise((resolve, reject) => {
            exec(`7z x -y -o"${tmpDir}" "${zipPath}"`, async (error, stdout, stderr) => {
                if (error) {
                    console.log('[7z] Błąd:', stderr);
                    reject(error);
                    return;
                }

                try {
                    const files = await fs.readdir(tmpDir);
                    const subtitleFiles = files.filter(f => 
                        /\.(srt|ass|ssa|sub|txt)$/i.test(f) && f !== 'archive.zip'
                    );

                    if (subtitleFiles.length === 0) {
                        reject(new Error('Brak plików napisów w archiwum'));
                        return;
                    }

                    const subtitlePath = path.join(tmpDir, subtitleFiles[0]);
                    const content = await fs.readFile(subtitlePath);
                    
                    await fs.rm(tmpDir, { recursive: true, force: true });
                    
                    resolve(content);
                } catch (err) {
                    reject(err);
                }
            });
        });
    } catch (error) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

function sniffUtf16NoBom(buf) {
    if (buf.length < 20) return false;
    let nulls = 0;
    for (let i = 0; i < Math.min(buf.length, 100); i++) {
        if (buf[i] === 0) nulls++;
    }
    return nulls > 10;
}

function tryDecodeUtf8Strict(buf) {
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        return decoder.decode(buf);
    } catch (e) {
        return null;
    }
}

function scorePolishText(t) {
    const polishChars = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;
    const matches = t.match(polishChars);
    return matches ? matches.length : 0;
}

function decodeSubtitleBuffer(buf) {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return { text: buf.slice(3).toString('utf-8'), encoding: 'UTF-8 (BOM)' };
    }

    const utf8Text = tryDecodeUtf8Strict(buf);
    if (utf8Text !== null) {
        return { text: utf8Text, encoding: 'UTF-8' };
    }

    if (sniffUtf16NoBom(buf)) {
        const utf16le = iconv.decode(buf, 'utf-16le');
        const utf16be = iconv.decode(buf, 'utf-16be');
        const scoreLE = scorePolishText(utf16le);
        const scoreBE = scorePolishText(utf16be);
        if (scoreLE > scoreBE) {
            return { text: utf16le, encoding: 'UTF-16LE' };
        } else {
            return { text: utf16be, encoding: 'UTF-16BE' };
        }
    }

    const cp1250Text = iconv.decode(buf, 'cp1250');
    const iso88592Text = iconv.decode(buf, 'iso-8859-2');

    const score1250 = scorePolishText(cp1250Text);
    const score88592 = scorePolishText(iso88592Text);

    if (score1250 > score88592) {
        return { text: cp1250Text, encoding: 'CP1250' };
    } else {
        return { text: iso88592Text, encoding: 'ISO-8859-2' };
    }
}

function toUtf8BufferWithBom(text) {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const content = Buffer.from(text, 'utf-8');
    return Buffer.concat([bom, content]);
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
        // WAŻNE: Tworzymy NOWĄ sesję dla każdego pobierania
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

        // Krok 1: Odwiedź stronę wyszukiwania żeby dostać ciasteczka i świeży hash
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
       
        // Krok 2: Znajdź ŚWIEŻY hash dla naszego ID
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

        // Krok 3: Pobierz napisy
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

        // Sprawdź czy to błąd zabezpieczeń
        const rawText = subtitleContent.toString('latin1');
        if (rawText.includes('zabezpiecze') || rawText.includes('Błąd') || rawText.includes('B³±d')) {
            console.log(`[Download] ✗ BŁĄD ZABEZPIECZEŃ!`);
            throw new Error('Błąd zabezpieczeń animesub.info - hash nieważny');
        }

        let subtitleExtension = '.srt';
        if (['ass', 'ssa', 'srt', 'txt', 'sub', 'vtt'].includes(extHint)) {
            subtitleExtension = '.' + extHint;
        }

        let isArchive = false;

        // Sprawdzenie czy to ZIP
        if (subtitleContent.length > 2 && subtitleContent[0] === 0x50 && subtitleContent[1] === 0x4B) {
            console.log('[Download] Wykryto archiwum ZIP, rozpakowuję...');
            isArchive = true;
            let extractedSuccessfully = false;
           
            try {
                const zip = new AdmZip(subtitleContent);
                const zipEntries = zip.getEntries();
                
                for (const entry of zipEntries) {
                    if (entry.isDirectory) continue;
                    
                    const fileName = entry.entryName.toLowerCase();
                    if (fileName.endsWith('.srt') || fileName.endsWith('.ass') || 
                        fileName.endsWith('.ssa') || fileName.endsWith('.sub') || 
                        fileName.endsWith('.txt')) {
                        
                        console.log(`[Download] Rozpakowuję: ${entry.entryName}`);
                        subtitleContent = entry.getData();
                        
                        if (fileName.endsWith('.ass')) {
                            subtitleExtension = '.ass';
                        } else if (fileName.endsWith('.ssa')) {
                            subtitleExtension = '.ssa';
                        } else if (fileName.endsWith('.srt')) {
                            subtitleExtension = '.srt';
                        }
                        
                        extractedSuccessfully = true;
                        break;
                    }
                }
            } catch (zipError) {
                console.log('[Download] AdmZip nie może rozpakować (prawdopodobnie LZMA), próbuję 7z...');
            }

            if (!extractedSuccessfully) {
                try {
                    subtitleContent = await extractWith7z(subtitleContent);
                    extractedSuccessfully = true;
                    console.log('[Download] ✓ Rozpakowano przez 7z');
                } catch (sevenZipError) {
                    console.error('[Download] ✗ 7z też nie może rozpakować:', sevenZipError.message);
                    throw new Error('Nie można rozpakować archiwum ZIP');
                }
            }

            if (!extractedSuccessfully) {
                throw new Error('Nie można rozpakować archiwum ZIP');
            }
        } else {
            // Jeśli nie ZIP – wykrywanie formatu na podstawie zawartości
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

        // Konwersja kodowania do UTF-8
        const decoded = decodeSubtitleBuffer(subtitleContent);
        let textContent = decoded.text;

        // Modyfikacja ASS – dodajemy {\an2} do linii bez pozycjonowania
        if (subtitleExtension === '.ass' || subtitleExtension === '.ssa') {
            const originalLength = textContent.split('\n').length;
            textContent = forceAn2(textContent);
            const newLength = textContent.split('\n').length;
            if (newLength !== originalLength) {
                console.log(`[forceAn2] Zmodyfikowano strukturę ASS (linie: ${originalLength} → ${newLength})`);
            } else {
                console.log('[forceAn2] Dodano \\an2 do niektórych linii Dialogue');
            }
        }

        // SRT lubi CRLF
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

// Automatyczne wykrywanie BASE_URL dla Hugging Face Spaces
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

// Get the addon interface once
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
   
    // Use getRouter with the interface, but create it fresh each time
    // or better yet, use it directly
    getRouter(addonInterface)(req, res, () => {
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
║ http://localhost:${PORT}/manifest.json                     ║
╚════════════════════════════════════════════════════════════╝
`);
});
