// api/manifest.js - Endpoint manifestu wtyczki Stremio
const manifest = require('../manifest');

module.exports = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).json(manifest);
};
