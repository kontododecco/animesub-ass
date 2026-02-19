// manifest.js - Definicja manifestu wtyczki
// NAPRAWIONE: usunięto proxyStreams (niekompatybilne z wieloma wersjami Stremio)
// resources jako tablica obiektów - bardziej kompatybilne
module.exports = {
    id: 'community.animesub.info',
    version: '1.1.0',
    name: 'ASI Sub',
    description: 'Polskie napisy do anime z animesub.info',
    logo: 'https://i.imgur.com/qKLYVZx.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: []
};
