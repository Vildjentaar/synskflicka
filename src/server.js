'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const { loadCatalog } = require('./catalog');
const { createProvider } = require('./llm');
const { createReadingService } = require('./readingService');
const { createInventory } = require('./inventory');
const { createMillionerRouter } = require('./millioner/router');

/** Tiny fixed-window in-memory rate limiter (per IP). Fine for a single-instance kiosk/festival deployment. */
function rateLimit({ perMinute }) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (req, res, next) => {
    const key = req.ip;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > perMinute) return res.status(429).json({ error: 'Ruhların biraz nefes alması lazım. Bir dakika sonra tekrar dene.' });
    next();
  };
}

function createApp({ catalog, provider, inventory, logger = console } = {}) {
  catalog = catalog || loadCatalog();
  provider = provider || createProvider(config.llm);
  // In-memory by default (tests); getDefaultApp() passes a file-backed inventory.
  inventory =
    inventory ||
    createInventory({ stickers: catalog.eligibleStickers, initialStock: config.stock.perSticker, categoryLabel: catalog.categoryLabel, logger });
  const readings = createReadingService({ catalog, provider, inventory, limits: config.reading, logger });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Support Vercel serverless rewrites and direct handlers:
  // When running behind Vercel rewrites (e.g. /api/(.*) -> /api/index.js), Vercel passes the original
  // request path in x-matched-path or query parameters. Restore it so Express routing matches seamlessly.
  app.use((req, res, next) => {
    const matchedPath = req.headers['x-matched-path'] || req.headers['x-vercel-matched-path'];
    if (matchedPath && (req.url.startsWith('/api/index') || req.url === '/' || req.url.startsWith('/api?'))) {
      const queryIdx = req.url.indexOf('?');
      const search = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
      req.url = matchedPath + search;
    } else if (req.url.startsWith('/api/index.js') || req.url.startsWith('/api/index')) {
      const parsed = new URL(req.url, 'http://localhost');
      const captured = parsed.searchParams.get('0') || parsed.searchParams.get('path');
      if (captured) {
        parsed.searchParams.delete('0');
        parsed.searchParams.delete('path');
        const remaining = parsed.searchParams.toString();
        req.url = '/api/' + captured.replace(/^\/+/, '') + (remaining ? '?' + remaining : '');
      }
    }
    next();
  });

  // Public deck list: IDs and display info only. Meanings stay server-side.
  const publicDeck = catalog.deck.map(({ id, name, arcana, suit, rank }) => ({ id, name, arcana, suit, rank }));

  const apiRouter = express.Router();
  apiRouter.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
  });
  apiRouter.get('/deck', (req, res) => res.json({ cards: publicDeck }));
  apiRouter.get('/health', (req, res) =>
    res.json({ ok: true, provider: provider.name, eligible_stickers: catalog.eligibleStickers.length })
  );
  apiRouter.post(
    '/generate-reading',
    rateLimit({ perMinute: config.rateLimitPerMinute }),
    express.json({ limit: '2kb' }),
    async (req, res) => {
      const started = Date.now();
      try {
        if (inventory && typeof inventory.ensureLoaded === 'function') {
          await inventory.ensureLoaded();
        }
        const result = await readings.generate(req.body);
        logger.info(
          JSON.stringify({
            event: 'reading',
            source: result.source,
            fallback_type: result.fallback_type || undefined,
            category: result.category_id,
            sticker: result.sticker.id,
            ms: Date.now() - started,
          })
        );
        res.json(result);
      } catch (err) {
        if (err.status === 400 || err.status === 503) return res.status(err.status).json({ error: err.message });
        logger.error(JSON.stringify({ event: 'reading_error', message: err.message }));
        res.status(500).json({ error: 'Kristal küre içinde bir şeyler ters gitti.' });
      }
    }
  );

  // "Sticker'ı al!": hand out one physical copy and log the whole inventory.
  apiRouter.post('/stickers/:id/take', rateLimit({ perMinute: config.rateLimitPerMinute }), async (req, res) => {
    const id = String(req.params.id).slice(0, 128);
    const taken = await inventory.take(id);
    if (!taken.ok && taken.reason === 'unknown') return res.status(404).json({ error: 'Böyle bir çıkartma yok.' });

    const sticker = catalog.getEligibleSticker(id);
    const stock = inventory.snapshot();
    const categories = inventory.categoryTotals();
    logger.info(
      JSON.stringify({
        event: taken.ok ? 'sticker_taken' : 'sticker_take_rejected',
        sticker: id,
        category: sticker ? sticker.primary_category : 'unknown',
        remaining: taken.remaining,
        total_remaining: inventory.total(),
        categories,
        stock: stock.map(({ id: sid, character, category, remaining, disabled }) => ({ id: sid, character, category, remaining, disabled })),
      })
    );

    const body = { sticker_id: id, remaining: taken.remaining, disabled: taken.remaining === 0, total_remaining: inventory.total(), categories, stock };
    if (!taken.ok) return res.status(409).json({ ...body, error: 'Bu çıkartma tükendi.' });
    res.json(body);
  });

  // Stock management API endpoints
  apiRouter.get('/stocks', async (req, res) => {
    if (inventory && typeof inventory.ensureLoaded === 'function') {
      await inventory.ensureLoaded(true);
    }
    res.json({
      ok: true,
      stock: inventory.snapshot(),
      categories: inventory.categoryTotals(),
      total_remaining: inventory.total(),
      initialStock: inventory.initialStock,
    });
  });

  apiRouter.post('/stocks/:id/adjust', express.json(), async (req, res) => {
    const id = String(req.params.id).slice(0, 128);
    const delta = parseInt(req.body && req.body.delta, 10) || 0;
    const result = await inventory.adjustStock(id, delta);
    if (!result.ok) return res.status(404).json({ error: 'Böyle bir çıkartma yok.' });
    res.json({
      ...result,
      stock: inventory.snapshot(),
      categories: inventory.categoryTotals(),
      total_remaining: inventory.total(),
    });
  });

  apiRouter.post('/stocks/:id/set', express.json(), async (req, res) => {
    const id = String(req.params.id).slice(0, 128);
    const count = req.body && req.body.count;
    const result = await inventory.setStock(id, count);
    if (!result.ok) return res.status(404).json({ error: 'Böyle bir çıkartma yok.' });
    res.json({
      ...result,
      stock: inventory.snapshot(),
      categories: inventory.categoryTotals(),
      total_remaining: inventory.total(),
    });
  });

  apiRouter.post('/stocks/:id/toggle', async (req, res) => {
    const id = String(req.params.id).slice(0, 128);
    const result = await inventory.toggleEnabled(id);
    if (!result.ok) return res.status(404).json({ error: 'Böyle bir çıkartma yok.' });
    res.json({
      ...result,
      stock: inventory.snapshot(),
      categories: inventory.categoryTotals(),
      total_remaining: inventory.total(),
    });
  });

  apiRouter.post('/stocks/:id/enable', express.json(), async (req, res) => {
    const id = String(req.params.id).slice(0, 128);
    const enabled = Boolean(req.body && req.body.enabled);
    const result = await inventory.setEnabled(id, enabled);
    if (!result.ok) return res.status(404).json({ error: 'Böyle bir çıkartma yok.' });
    res.json({
      ...result,
      stock: inventory.snapshot(),
      categories: inventory.categoryTotals(),
      total_remaining: inventory.total(),
    });
  });

  apiRouter.post('/stocks/bulk', express.json(), async (req, res) => {
    const action = req.body && req.body.action;
    if (action === 'enable_all') {
      await inventory.setAllEnabled(true);
    } else if (action === 'disable_all') {
      await inventory.setAllEnabled(false);
    } else if (action === 'reset') {
      await inventory.resetStock(req.body && req.body.initialStock);
    } else if (action === 'adjust_all') {
      await inventory.adjustAllStock(req.body && req.body.delta);
    } else {
      return res.status(400).json({ error: 'Geçersiz işlem.' });
    }
    res.json({
      ok: true,
      stock: inventory.snapshot(),
      categories: inventory.categoryTotals(),
      total_remaining: inventory.total(),
    });
  });

  // Serve the stocks page
  app.get('/stocks', (req, res) => {
    res.sendFile(path.join(config.paths.public, 'stocks.html'));
  });

  // Millioner mini-project integration
  const millionerApi = createMillionerRouter();
  apiRouter.use(millionerApi);

  const millionerFrontendDir = fs.existsSync(path.join(config.paths.public, 'millioner'))
    ? path.join(config.paths.public, 'millioner')
    : path.join(config.root, 'millioner', 'frontend');

  // Millioner page routes
  app.use('/milyoner', (req, res) => {
    const sub = req.url === '/' ? '/' : req.url;
    res.redirect('/millioner' + sub);
  });

  app.get('/millioner/game', (req, res) => {
    res.sendFile(path.join(millionerFrontendDir, 'game.html'));
  });
  app.get('/millioner/leaderboard', (req, res) => {
    res.sendFile(path.join(millionerFrontendDir, 'leaderboard.html'));
  });
  app.get('/millioner/admin', (req, res) => {
    res.sendFile(path.join(millionerFrontendDir, 'admin.html'));
  });

  app.use('/millioner/api', millionerApi);
  app.use('/millioner', express.static(millionerFrontendDir, { maxAge: config.isProduction ? '1h' : 0 }));

  // Mount router at both /api and / so both direct and rewritten serverless requests match
  app.use('/api', apiRouter);
  app.use('/', apiRouter);

  // Malformed JSON / oversized bodies from express.json
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'İstek çok büyük.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Geçersiz JSON.' });
    next(err);
  });

  const stickersDir = fs.existsSync(path.join(config.paths.public, 'stickers'))
    ? path.join(config.paths.public, 'stickers')
    : path.join(config.root, 'stickers');
  app.use('/stickers', express.static(stickersDir, { maxAge: '1h' }));
  app.use('/stickers', (req, res) => res.status(404).end());
  app.use(express.static(config.paths.public, { maxAge: config.isProduction ? '1h' : 0 }));

  return app;
}

let defaultApp;
function getDefaultApp() {
  if (!defaultApp) {
    let catalog;
    try {
      catalog = loadCatalog();
    } catch (e) {
      console.error(e.message);
      throw e;
    }
    catalog.warnings.forEach((w) => console.warn(`[data] ${w}`));
    const inventory = createInventory({
      stickers: catalog.eligibleStickers,
      initialStock: config.stock.perSticker,
      filePath: config.paths.stock,
      categoryLabel: catalog.categoryLabel,
    });
    defaultApp = createApp({ catalog, inventory });
  }
  return defaultApp;
}

if (require.main === module) {
  const app = getDefaultApp();
  app.listen(config.port, () => {
    console.log(`Tarot Sticker Game on http://localhost:${config.port}  (LLM: ${config.llm.provider}, strict assets: ${config.strictAssets})`);
  });
}

const serverlessHandler = (req, res) => {
  const matchedPath = req.headers && (req.headers['x-matched-path'] || req.headers['x-vercel-matched-path']);
  if (matchedPath && (req.url.startsWith('/api/index') || req.url === '/' || req.url.startsWith('/api?'))) {
    const queryIdx = req.url.indexOf('?');
    const search = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
    req.url = matchedPath + search;
  }
  return getDefaultApp()(req, res);
};
serverlessHandler.createApp = createApp;
serverlessHandler.getDefaultApp = getDefaultApp;

module.exports = serverlessHandler;
