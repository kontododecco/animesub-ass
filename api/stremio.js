// api/stremio.js - Główny handler dla żądań Stremio (napisy)
// ZOPTYMALIZOWANY: równoległe zapytania, agresywne timeouty
const manifest = require('../manifest');
const {
    getBaseUrl,
    getMetaInfo,
    searchSubtitles,
    generateSearchStrategies,
    matchSubtitles,
    createSubtitleUrl
} = require('../core');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, X-Requested-With'
};

module.exports = async (req, res) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

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
    if (!subtitleMatch) {
        return res.status(404).json({ error: 'Not found' });
    }

    const type = subtitleMatch[1];
    const id = subtitleMatch[2];
    const baseUrl = getBaseUrl(req);

    console.log(`\n[Request] type=${type}, id=${id}`);

    // Globalny timeout: 8s (zostawia 2s bufor dla Vercel Free 10s)
    const GLOBAL_TIMEOUT = 8000;
    const deadline = Date.now() + GLOBAL_TIMEOUT;
    const timeLeft = () => Math.max(0, deadline - Date.now());

    try {
        // Pobierz metadane z timeoutem
        const meta = await Promise.race([
            getMetaInfo(type, id),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Meta timeout')), Math.min(4500, timeLeft()))
            )
        ]).catch(err => {
            console.error('[Meta] Timeout/błąd:', err.message);
            return null;
        });

        if (!meta || !meta.title) {
            console.log('[Błąd] Nie udało się pobrać tytułu');
            return res.status(200).json({ subtitles: [] });
        }

        console.log(`[Meta] title="${meta.title}", season=${meta.season}, episode=${meta.episode}`);

        const strategies = generateSearchStrategies(meta.title, meta.season, meta.episode);
        console.log(`[Strategie] ${strategies.length}: ${strategies.map(s => `"${s.query}"`).join(', ')}`);

        // KLUCZOWA ZMIANA: wszystkie strategie równolegle zamiast sekwencyjnie
        const remainingTime = timeLeft();
        if (remainingTime < 500) {
            return res.status(200).json({ subtitles: [] });
        }

        const searchResults = await Promise.allSettled(
            strategies.map(strategy =>
                Promise.race([
                    searchSubtitles(strategy.query, strategy.type).then(results => ({ results, strategy })),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Search timeout')), Math.min(5000, remainingTime - 200))
                    )
                ])
            )
        );

        // Zbierz wyniki
        const seenIds = new Set();
        const allSubtitles = [];

        for (const result of searchResults) {
            if (result.status !== 'fulfilled') {
                console.log(`[Search] Błąd: ${result.reason?.message}`);
                continue;
            }
            const { results, strategy } = result.value;
            const matched = matchSubtitles(results, meta.season, meta.episode);
            for (const sub of matched) {
                if (!seenIds.has(sub.id)) {
                    seenIds.add(sub.id);
                    allSubtitles.push({ ...sub, searchQuery: strategy.query, searchType: strategy.type });
                }
            }
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

        const elapsed = GLOBAL_TIMEOUT - timeLeft();
        console.log(`[Wynik] ${stremioSubtitles.length} napisów w ~${elapsed}ms`);
        return res.status(200).json({ subtitles: stremioSubtitles });

    } catch (error) {
        console.error('[Błąd]', error.message);
        return res.status(200).json({ subtitles: [] });
    }
};
