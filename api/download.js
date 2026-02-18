// api/download.js - Endpoint pobierania napisów
const { handleDownload } = require('../core');

module.exports = async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent');
        res.status(204).end();
        return;
    }

    await handleDownload(req, res);
};
