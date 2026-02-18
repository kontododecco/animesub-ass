// api/stremio.js - Główny handler dla żądań Stremio
const manifest = require('../manifest');
const {
    getBaseUrl,
    getMetaInfo,
    searchSubtitles,
    generateSearchStrategies,
    matchSubtitles,
    createSubtitleUrl
} = require('../core');

module.exports = async (req, res) => {
    // CORS - zawsze
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, X-Requested-With');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    // Parsuj URL - req.url może być z lub bez query string
    const rawPath = req.url.split('?')[0]; // tylko ścieżka, bez query
    console.log(`[Stremio] ${req.method} ${rawPath}`);

    // --- Manifest ---
    if (rawPath === '/' || rawPath === '/manifest.json' || rawPath === '') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.status(200).json(manifest);
    }

    // --- Napisy: /subtitles/{type}/{id}.json ---
    // Stremio używa formatu: /subtitles/series/tt1234567%3A1%3A2.json
    // lub: /subtitles/series/tt1234567:1:2.json
    const subtitleMatch = rawPath.match(/^\/subtitles\/([^/]+)\/(.+?)(?:\.json)?$/);
    if (subtitleMatch) {
        const type = subtitleMatch[1];
        // Dekoduj URL-encoded ID (np. tt1234567%3A1%3A2 -> tt1234567:1:2)
        const id = decodeURIComponent(subtitleMatch[2]);
        const baseUrl = getBaseUrl(req);

        console.log(`[Subtitles] type=${type}, id=${id}`);

        const GLOBAL_TIMEOUT = 8500;
        const deadline = Date.now() + GLOBAL_TIMEOUT;
        const timeLeft = () => Math.max(0, deadline - Date.now());

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');

        try {
            const meta = await Promise.race([
                getMetaInfo(type, id),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Meta timeout')), Math.min(4000, timeLeft()))
                )
            ]).catch(err => {
                console.error('[Meta] Błąd:', err.message);
                return null;
            });

            if (!meta || !meta.title) {
                console.log('[Meta] Brak tytułu - zwracam pustą listę');
                return res.status(200).json({ subtitles: [] });
            }

            console.log(`[Meta] "${meta.title}" s${meta.season}e${meta.episode}`);

            const strategies = generateSearchStrategies(meta.title, meta.season, meta.episode);

            const searchResults = await Promise.allSettled(
                strategies.map(strategy =>
                    Promise.race([
                        searchSubtitles(strategy.query, strategy.type)
                            .then(results => ({ results, strategy })),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Search timeout')), Math.min(5000, timeLeft() - 200))
                        )
                    ])
                )
            );

            const seenIds = new Set();
            const allSubtitles = [];

            for (const result of searchResults) {
                if (result.status !== 'fulfilled') continue;
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

            const stremioSubtitles = [];

            for (const sub of allSubtitles.slice(0, 10)) {
                let format = 'srt';
                const descLower = (sub.description || '').toLowerCase();
                const typeLower = (sub.formatType || '').toLowerCase();
                if (descLower.includes('.ass') || typeLower.includes('ass')) format = 'ass';
                else if (descLower.includes('.ssa') || typeLower.includes('ssa')) format = 'ssa';

                const baseLabel = [
                    sub.titleEng || sub.titleOrg,
                    sub.author ? `by ${sub.author}` : null,
                    sub.downloadCount ? `⬇ ${sub.downloadCount}` : null
                ].filter(Boolean).join(' | ');

                // Oryginalny wpis (ASS/SSA/SRT)
                stremioSubtitles.push({
                    id: `animesub-${sub.id}`,
                    url: createSubtitleUrl(sub, sub.searchQuery, sub.searchType, format, baseUrl),
                    lang: 'pol',
                    SubtitleName: `${baseLabel} [${format.toUpperCase()}]`
                });

                // Dodatkowy wpis VTT dla ASS/SSA
                if (format === 'ass' || format === 'ssa') {
                    stremioSubtitles.push({
                        id: `animesub-${sub.id}-vtt`,
                        url: createSubtitleUrl(sub, sub.searchQuery, sub.searchType, format, baseUrl, true),
                        lang: 'pol',
                        SubtitleName: `${baseLabel} [VTT]`
                    });
                }
            }

            console.log(`[Wynik] ${stremioSubtitles.length} napisów`);
            return res.status(200).json({ subtitles: stremioSubtitles });

        } catch (error) {
            console.error('[Błąd subtitles]', error.message);
            return res.status(200).json({ subtitles: [] });
        }
    }

    // --- Wszystko inne (np. /catalog, /meta itp.) ---
    // Zwróć puste odpowiedzi zamiast 404 - Stremio może odpytywać różne endpointy
    if (rawPath.startsWith('/catalog/')) {
        return res.status(200).json({ metas: [] });
    }
    if (rawPath.startsWith('/meta/')) {
        return res.status(200).json({ meta: {} });
    }
    if (rawPath.startsWith('/stream/')) {
        return res.status(200).json({ streams: [] });
    }

    console.log(`[404] Nieznana ścieżka: ${rawPath}`);
    return res.status(404).json({ error: 'Not found', path: rawPath });
};
