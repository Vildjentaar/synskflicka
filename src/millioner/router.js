'use strict';

const express = require('express');
const crypto = require('crypto');
const {
  TOTAL_LEVELS,
  SAFE_LEVELS,
  LADDER,
  JOKERS,
  GRADE_LABELS,
  sanitizeName,
  loadQuestions,
  saveQuestions,
  store,
} = require('./gameLogic');
const {
  loadSettings,
  saveSettings,
  persistScore,
  getLeaderboard,
  getStats,
  resetScores,
  exportScoresCSV,
} = require('./store');
const { createQRCodeSVG } = require('./qr');

const ADMIN_KEY = 'akdeniz2026';

function checkAdmin(req, res, next) {
  const key = req.query.secret_key || (req.body && req.body.secret_key);
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ detail: 'Geçersiz yetki anahtarı' });
  }
  next();
}

async function getSessionOr404(sid, res) {
  const s = await store.get(sid);
  if (!s) {
    res.status(404).json({ detail: 'Oturum bulunamadı' });
    return null;
  }
  return s;
}

function createMillionerRouter() {
  const router = express.Router();
  router.use(express.json());

  // Disable caching for game API responses
  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    next();
  });

  // Config
  router.get('/config', (req, res) => {
    res.json({
      total_levels: TOTAL_LEVELS,
      safe_levels: [...SAFE_LEVELS].sort((a, b) => a - b),
      ladder: LADDER.map(([v, l]) => ({ value: v, label: l })),
      jokers: JOKERS,
      question_count: loadQuestions().length,
      join_url: loadSettings().join_url || '',
      grade_labels: GRADE_LABELS,
    });
  });

  // Game Start
  router.post('/game/start', async (req, res) => {
    let name = sanitizeName(req.body && req.body.name);
    if (name.length < 2) name = 'Gizli Yarışmacı';
    const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 120);
    let grade = String((req.body && req.body.grade) || 'hazirlik').trim().toLowerCase();
    if (!GRADE_LABELS[grade]) grade = 'hazirlik';
    const wantsMembership = Boolean(req.body && req.body.wants_membership);

    try {
      const s = await store.create(name, email, wantsMembership, grade);
      res.json(s.publicState());
    } catch (err) {
      res.status(500).json({ detail: err.message });
    }
  });

  // Game State
  router.get('/game/:sid', async (req, res) => {
    const s = await getSessionOr404(req.params.sid, res);
    if (s) res.json(s.publicState());
  });

  // Answer
  router.post('/game/:sid/answer', async (req, res) => {
    const s = await getSessionOr404(req.params.sid, res);
    if (!s) return;

    const choice = typeof req.body?.choice === 'number' ? req.body.choice : -1;
    try {
      const result = s.answer(choice);
      if (s.status !== 'playing') {
        result.rank = await persistScore(s);
      } else {
        result.state = result.result === 'retry' ? s.publicState() : null;
      }
      await store.save(s);
      res.json(result);
    } catch (err) {
      res.status(400).json({ detail: err.message });
    }
  });

  // Next Question
  router.post('/game/:sid/next', async (req, res) => {
    const s = await getSessionOr404(req.params.sid, res);
    if (!s) return;

    if (s.status === 'playing' && !s.timer_armed) {
      s.question_started = Date.now() / 1000;
      s.timer_armed = true;
    }
    await store.save(s);
    res.json(s.publicState());
  });

  // Joker
  router.post('/game/:sid/joker/:key', async (req, res) => {
    const s = await getSessionOr404(req.params.sid, res);
    if (!s) return;

    try {
      const payload = s.useJoker(req.params.key);
      await store.save(s);
      res.json(payload);
    } catch (err) {
      res.status(400).json({ detail: err.message });
    }
  });

  // Withdraw
  router.post('/game/:sid/withdraw', async (req, res) => {
    const s = await getSessionOr404(req.params.sid, res);
    if (!s) return;

    try {
      const result = s.withdraw();
      result.rank = await persistScore(s);
      await store.save(s);
      res.json(result);
    } catch (err) {
      res.status(400).json({ detail: err.message });
    }
  });

  // Leaderboard
  router.get('/leaderboard', async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const grade = req.query.grade ? String(req.query.grade).trim() : null;
    res.json(await getLeaderboard({ limit, grade }));
  });

  // Stats
  router.get('/stats', async (req, res) => {
    res.json(await getStats());
  });

  // QR Code
  router.get('/qr', (req, res) => {
    const url = loadSettings().join_url || '';
    if (!url) {
      return res.status(404).json({ detail: 'Katılım linki ayarlanmamış' });
    }
    try {
      const svg = createQRCodeSVG(url);
      res.set('Content-Type', 'image/svg+xml');
      res.send(svg);
    } catch (e) {
      res.status(500).json({ detail: 'QR kod oluşturulamadı: ' + e.message });
    }
  });

  // Admin: Questions
  router.get('/admin/questions', checkAdmin, (req, res) => {
    res.json({ questions: loadQuestions() });
  });

  router.post('/admin/questions', checkAdmin, (req, res) => {
    const body = req.body || {};
    const item = {
      id: 'q_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      level: parseInt(body.level, 10) || 1,
      grade: String(body.grade || 'all'),
      category: String(body.category || 'Genel'),
      question: String(body.question || ''),
      options: Array.isArray(body.options) ? body.options.slice(0, 4) : [],
      answer: parseInt(body.answer, 10) || 0,
      explanation: String(body.explanation || ''),
    };

    if (!item.question || item.options.length !== 4) {
      return res.status(400).json({ detail: 'Geçersiz soru verisi' });
    }

    const list = [...loadQuestions(), item];
    saveQuestions(list);
    res.json({ success: true, question: item });
  });

  router.delete('/admin/questions/:qid', checkAdmin, (req, res) => {
    const qid = req.params.qid;
    const questions = [...loadQuestions()];
    const target = questions.find((q) => q.id === qid);
    if (!target) {
      return res.status(404).json({ detail: 'Soru bulunamadı' });
    }

    const sameLevel = questions.filter((q) => q.level === target.level);
    if (sameLevel.length <= 2) {
      return res.status(400).json({ detail: 'Her seviyede en az 2 soru kalmalı' });
    }

    const filtered = questions.filter((q) => q.id !== qid);
    saveQuestions(filtered);
    res.json({ success: true });
  });

  // Admin: Settings
  router.get('/admin/settings', checkAdmin, (req, res) => {
    res.json(loadSettings());
  });

  router.post('/admin/settings', checkAdmin, (req, res) => {
    const data = loadSettings();
    if (req.body && typeof req.body.join_url === 'string') {
      data.join_url = req.body.join_url.trim();
    }
    saveSettings(data);
    res.json({ success: true, ...data });
  });

  // Admin: Reset
  router.post('/admin/reset', checkAdmin, async (req, res) => {
    await resetScores();
    res.json({ success: true, message: 'Skorlar sıfırlandı' });
  });

  // Admin: Export CSV
  router.get('/admin/export', checkAdmin, (req, res) => {
    const csv = exportScoresCSV();
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename=milyoner_katilimcilar.csv',
    });
    res.send(csv);
  });

  return router;
}

module.exports = { createMillionerRouter };
