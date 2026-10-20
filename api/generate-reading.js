'use strict';
const server = require('../src/server');

module.exports = (req, res) => {
  if (!req.url || req.url === '/' || !req.url.startsWith('/api')) {
    const search = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = '/api/generate-reading' + search;
  }
  return server(req, res);
};
