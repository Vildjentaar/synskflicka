'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const { loadCatalog } = require('./catalog');
const { createProvider } = require('./llm');
const { createReadingService } = require('./readingService');
const { createInventory } = require('./inventory');

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
  apiRouter.post('/stickers/:id/take', rateLimit({ perMinute: config.rateLimitPerMinute }), (req, res) => {
    const id = String(req.params.id).slice(0, 128);
    const taken = inventory.take(id);
    if (!taken.ok && taken.reason === 'unknown') return res.status(404).json({ error: 'Böyle bir çıkartma yok.' });

    const sticker = catalog.getEligibleSticker(id);
    const stock = inventory.snapshot();
    const categories = inventory.categoryTotals();
    logger.info(
      JSON.stringify({
        event: taken.ok ? 'sticker_taken' : 'sticker_take_rejected',
        sticker: id,
        category: sticker.primary_category,
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

const serverlessHandler = (req, res) => getDefaultApp()(req, res);
serverlessHandler.createApp = createApp;
serverlessHandler.getDefaultApp = getDefaultApp;

module.exports = serverlessHandler;
