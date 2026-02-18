const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const { TextDecoder } = require('util');

// Konfiguracja
const BASE_URL = 'http://animesub.info';
const SEARCH_URL = `${BASE_URL}/szukaj.php`;
const DOWNLOAD_URL = `${BASE_URL}/sciagnij.php`;

// Manifest wtyczki
const manifest = {
    id: 'community.animesub.info',
    version: '1.1.0',
    name: 'AnimeSub.info Subtitles',
    description: 'Polskie napisy do anime z animesub.info (Vercel edition)',
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

// Sesja HTTP
const session = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Charset': 'ISO-8859-2,utf-8;q=0.7,*;q=0.3',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl,en;q=0.9'
    },
    responseType: 'arraybuffer',
    timeout: 10000,
    maxRedirects: 3
});

// Cache (Pamiętaj: na Vercel cache działa tylko w obrębie jednego "rozgrzanego" kontenera)
const metaCache = new Map();
const META_CACHE_TTL = 60 * 60 * 1000;

/**
 * Pobiera informacje o tytule
 */
async function getMetaInfo(type, id) {
    const cacheKey = `${type}:${id}`;
    if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);

    const parts = id.split(':');
    const prefix = parts[0];
    let season = null, episode = null, title = null, year = null;

    if (prefix === 'kitsu') {
        const kitsuId = parts[1];
        episode = parts.length >= 3 ? parseInt(parts[2], 10) : null;
        try {
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 5000 });
            const anime = res.data.data.attributes;
            title = anime.titles?.en || anime.canonicalTitle;
            year = anime.startDate ? parseInt(anime.startDate.substring(0, 4), 10) : null;
        } catch (e) { console.error('Kitsu error'); }
    } else {
        const imdbId = parts[0];
        if (type === 'series' && parts.length >= 3) {
            season = parseInt(parts[1], 10);
            episode = parseInt(parts[2], 10);
        }
        try {
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
            title = res.data.meta.name;
            year = res.data.meta.year;
        } catch (e) { console.error('Cinemeta error'); }
    }

    const result = { title, year, season, episode };
    metaCache.set(cacheKey, result);
    return result;
}

/**
 * Wyszukiwanie na animesub.info
 */
async function searchSubtitles(title, titleType = 'en') {
    try {
        const response = await session.get(SEARCH_URL, {
            params: { szukane: title, pTitle: titleType, pSortuj: 'pobrn' }
        });
        const html = iconv.decode(Buffer.from(response.data), 'ISO-8859-2');
        return parseSearchResults(html);
    } catch (e) { return []; }
}

function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const subtitles = [];
    $('table.Napisy[style*="text-align:center"]').each((i, table) => {
        const rows = $(table).find('tr.KNap');
        if (rows.length < 3) return;
        const subtitleId = $(table).find('input[name="id"]').val();
        const downloadHash = $(table).find('input[name="sh"]').val();
        if (!subtitleId || !downloadHash) return;

        subtitles.push({
            id: subtitleId,
            hash: downloadHash,
            titleOrg: $(rows[0]).find('td').first().text().trim(),
            titleEng: $(rows[1]).find('td').first().text().trim(),
            author: $(rows[1]).find('td').eq(1).text().trim(),
            description: $(table).find('tr.KKom td.KNap[align="left"]').text().trim()
        });
    });
    return subtitles;
}

function generateSearchStrategies(title, season, episode) {
    const clean = title.replace(/\s+/g, ' ').trim();
    const strategies = [];
    if (episode) {
        const epStr = String(episode).padStart(2, '0');
        strategies.push({ type: 'en', query: `${clean} ep${epStr}` });
    }
    strategies.push({ type: 'en', query: clean });
    return strategies;
}

function createSubtitleUrl(subtitle, host, format = 'srt') {
    const params = new URLSearchParams({
        id: subtitle.id,
        hash: subtitle.hash,
        format: format
    });
    return `https://${host}/subtitles/download.${format}?${params.toString()}`;
}

// Handler Stremio
builder.defineSubtitlesHandler(async ({ type, id }, req) => {
    const host = req.headers.host;
    try {
        const meta = await getMetaInfo(type, id);
        if (!meta.title) return { subtitles: [] };

        const strategies = generateSearchStrategies(meta.title, meta.season, meta.episode);
        let allSubtitles = [];

        for (const strategy of strategies) {
            const results = await searchSubtitles(strategy.query, strategy.type);
            if (results.length > 0) {
                allSubtitles = results.slice(0, 5);
                break;
            }
        }

        const stremioSubs = allSubtitles.map(sub => ({
            id: `animesub-${sub.id}`,
            url: createSubtitleUrl(sub, host),
            lang: 'pol',
            SubtitleName: `${sub.titleEng || sub.titleOrg} | by ${sub.author}`
        }));

        return { subtitles: stremioSubs };
    } catch (e) { return { subtitles: [] }; }
});

/**
 * Pobieranie i wypakowywanie (ADM-ZIP zamiast 7z)
 */
async function handleDownload(req, res) {
    const { id, hash } = req.query;
    try {
        const formData = new URLSearchParams();
        formData.append('id', id);
        formData.append('sh', hash);

        const response = await session.post(DOWNLOAD_URL, formData.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const zip = new AdmZip(Buffer.from(response.data));
        const zipEntries = zip.getEntries();
        const subFile = zipEntries.find(e => /\.(srt|ass|ssa|txt)$/i.test(e.entryName));

        if (!subFile) throw new Error('No sub file');

        let content = subFile.getData();
        // Dekodowanie (animesub często używa windows-1250)
        let text = iconv.decode(content, 'windows-1250');
        
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(Buffer.from(text, 'utf-8'));
    } catch (e) {
        res.status(500).send(e.message);
    }
}

// Router
const router = getRouter(builder.getInterface());

module.exports = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.url.includes('/subtitles/download')) {
        return handleDownload(req, res);
    }

    router(req, res, () => {
        res.status(404).send("Not Found");
    });
};
