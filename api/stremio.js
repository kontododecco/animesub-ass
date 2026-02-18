// api/stremio.js - Główny handler dla żądań Stremio (napisy)
const manifest = require('../manifest');
const {
    getBaseUrl,
    getMetaInfo,
    searchSubtitles,
    generateSearchStrategies,
    matchSubtitles,
    createSubtitleUrl
} = require('../core');

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, X-Requested-With');
}

module.exports = async (req, res) => {
    setCorsHeaders(res);

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const pathname = url.pathname;

    // Manifest
    if (pathname === '/' || pathname === '/manifest.json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.status(200).json(manifest);
    }

    // Napisy: /subtitles/{type}/{id}.json
    const subtitleMatch = pathname.match(/^\/subtitles\/([^/]+)\/(.+)\.json$/);
    if (subtitleMatch) {
        const type = subtitleMatch[1];
        const id = subtitleMatch[2];
        const baseUrl = getBaseUrl(req);

        console.log(`\n[Request] type=${type}, id=${id}`);

        try {
            const meta = await getMetaInfo(type, id);
            console.log(`[Meta] title="${meta.title}", season=${meta.season}, episode=${meta.episode}`);

            if (!meta.title) {
                console.log('[Błąd] Nie udało się pobrać tytułu');
                return res.status(200).json({ subtitles: [] });
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
                        allSubtitles.push({ ...sub, searchQuery: strategy.query, searchType: strategy.type });
                    }
                }

                const exactMatch = matched.some(s =>
                    s.episode === meta.episode &&
                    (meta.season === null || meta.season === 1 || s.season === meta.season)
                );
                if (exactMatch && matched.length >= 1) break;
                if (allSubtitles.length >= 5) break;
            }

            allSubtitles.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));

            const stremioSubtitles = allSubtitles.slice(0, 10).map(sub => {
                let format = 'srt';
                const descLower = (sub.description || '').toLowerCase();
                const typeLower = (sub.formatType || '').toLowerCase();
                if (descLower.includes('.ass') || typeLower.includes('ass')) format = 'ass';
                else if (descLower.includes('.ssa') || typeLower.includes('ssa')) format = 'ssa';

                const label = [
                    sub.titleEng || sub.titleOrg,
                    sub.author ? `by ${sub.author}` : null,
                    `[${format.toUpperCase()}]`,
                    sub.downloadCount ? `⬇ ${sub.downloadCount}` : null
                ].filter(Boolean).join(' | ');

                return {
                    id: `animesub-${sub.id}`,
                    url: createSubtitleUrl(sub, sub.searchQuery, sub.searchType, format, baseUrl),
                    lang: 'pol',
                    SubtitleName: label
                };
            });

            console.log(`[Wynik] Zwracam ${stremioSubtitles.length} napisów`);
            return res.status(200).json({ subtitles: stremioSubtitles });

        } catch (error) {
            console.error('[Błąd]', error);
            return res.status(200).json({ subtitles: [] });
        }
    }

    // Nieznana ścieżka
    res.status(404).json({ error: 'Not found' });
};
