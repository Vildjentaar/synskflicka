'use strict';
const server = require('../src/server');

module.exports = (req, res) => {
  const matched = req.headers && (req.headers['x-matched-path'] || req.headers['x-vercel-matched-path']);
  if (matched && matched.startsWith('/api/stocks')) {
    const search = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = matched + search;
  } else if (!req.url || req.url === '/' || !req.url.startsWith('/api')) {
    const search = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = '/api/stocks' + search;
  }
  return server(req, res);
};
