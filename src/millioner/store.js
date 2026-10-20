'use strict';

const fs = require('fs');
const path = require('path');
const { GRADE_LABELS } = require('./gameLogic');
const kv = require('../kv');

const DB_PATH = path.join(__dirname, '..', '..', 'millioner', 'backend', 'milyoner.db');
const SETTINGS_PATH = path.join(__dirname, '..', '..', 'millioner', 'settings.json');

let db = null;
const memoryScores = [];

function initDB() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE,
        name TEXT NOT NULL,
        email TEXT,
        grade TEXT DEFAULT 'hazirlik',
        wants_membership INTEGER DEFAULT 0,
        correct_count INTEGER NOT NULL,
        prize_value INTEGER NOT NULL,
        prize_label TEXT NOT NULL,
        status TEXT NOT NULL,
        total_time REAL NOT NULL,
        jokers_used INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_rank ON scores (correct_count DESC, total_time ASC);
    `);

    // Preload baseline scores from SQLite into memoryScores
    const rows = db.prepare('SELECT * FROM scores ORDER BY correct_count DESC, total_time ASC').all();
    for (const r of rows) {
      memoryScores.push({ ...r });
    }
  } catch (err) {
    console.warn('[millioner] node:sqlite unavailable or read-only, using memory store for scores:', err.message);
  }

  // Pre-seed and sync with Vercel KV if available
  if (kv.isEnabled) {
    kv.get('synskflicka:millioner_scores')
      .then((cloudScores) => {
        if (Array.isArray(cloudScores) && cloudScores.length > 0) {
          memoryScores.length = 0;
          memoryScores.push(...cloudScores);
        } else if (memoryScores.length > 0) {
          kv.set('synskflicka:millioner_scores', memoryScores).catch(() => {});
        }
      })
      .catch((err) => {
        console.warn('[kv] Failed to pull scores from KV:', err.message);
      });
  }
}

initDB();

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[millioner] Error reading settings.json:', e.message);
  }
  return { join_url: '' };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.warn('[millioner] Could not persist settings.json (read-only environment)');
  }
  if (kv.isEnabled) {
    kv.set('synskflicka:millioner_settings', settings).catch(() => {});
  }
}

async function persistScore(s) {
  if (s.saved || s.status === 'playing') return null;
  const summary = s.resultSummary();
  const grade = s.grade || 'hazirlik';
  const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // 1. Try to write to local SQLite database if writable
  if (db) {
    try {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO scores
        (session_id, name, email, grade, wants_membership, correct_count, prize_value,
         prize_label, status, total_time, jokers_used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        s.id,
        s.name,
        s.email,
        grade,
        s.wants_membership ? 1 : 0,
        summary.correct_count,
        summary.prize_value,
        summary.prize_label,
        s.status,
        summary.total_time,
        summary.jokers_used,
        createdAt
      );
    } catch (e) {
      // Ignored if SQLite is on a read-only filesystem (e.g. Vercel)
    }
  }

  // 2. Update memoryScores
  const existingIdx = memoryScores.findIndex((item) => item.session_id === s.id);
  const scoreRecord = {
    id: memoryScores.length + 1,
    session_id: s.id,
    name: s.name,
    email: s.email,
    grade,
    wants_membership: s.wants_membership ? 1 : 0,
    correct_count: summary.correct_count,
    prize_value: summary.prize_value,
    prize_label: summary.prize_label,
    status: s.status,
    total_time: summary.total_time,
    jokers_used: summary.jokers_used,
    created_at: createdAt,
  };

  if (existingIdx >= 0) {
    memoryScores[existingIdx] = scoreRecord;
  } else {
    memoryScores.push(scoreRecord);
  }

  // 3. Sync to Vercel KV if available (must be awaited before response completes)
  if (kv.isEnabled) {
    try {
      await kv.set('synskflicka:millioner_scores', memoryScores);
    } catch (err) {
      console.warn('[kv] Failed to persist score to KV:', err.message);
    }
  }

  // Calculate rank based on all known scores
  const higher = memoryScores.filter(
    (m) =>
      m.correct_count > summary.correct_count ||
      (m.correct_count === summary.correct_count && m.total_time < summary.total_time)
  );
  const rank = higher.length + 1;

  s.saved = true;
  return rank;
}

async function getLeaderboard({ limit = 50, grade = null } = {}) {
  // Always fetch latest cloud scores if Vercel KV is enabled
  if (kv.isEnabled) {
    try {
      const cloudScores = await kv.get('synskflicka:millioner_scores');
      if (Array.isArray(cloudScores) && cloudScores.length > 0) {
        memoryScores.length = 0;
        memoryScores.push(...cloudScores);
      }
    } catch (e) {
      console.warn('[kv] Failed to refresh leaderboard from KV:', e.message);
    }
  }

  let filtered = [...memoryScores];
  if (grade && grade in GRADE_LABELS) {
    filtered = filtered.filter((r) => r.grade === grade);
  }

  filtered.sort((a, b) => {
    if (b.correct_count !== a.correct_count) return b.correct_count - a.correct_count;
    return a.total_time - b.total_time;
  });

  const scores = filtered.slice(0, limit).map((r, idx) => ({
    ...r,
    rank: idx + 1,
    grade_label: GRADE_LABELS[r.grade] || 'Hazırlık',
  }));

  const millionaires = memoryScores
    .filter((r) => r.status === 'won')
    .sort((a, b) => a.total_time - b.total_time)
    .map((w) => ({
      ...w,
      grade_label: GRADE_LABELS[w.grade] || 'Hazırlık',
    }));

  return { scores, millionaires };
}

async function getStats() {
  if (kv.isEnabled) {
    try {
      const cloudScores = await kv.get('synskflicka:millioner_scores');
      if (Array.isArray(cloudScores) && cloudScores.length > 0) {
        memoryScores.length = 0;
        memoryScores.push(...cloudScores);
      }
    } catch (e) {}
  }

  const total = memoryScores.length;
  const winners = memoryScores.filter((r) => r.status === 'won').length;
  const totalCorrect = memoryScores.reduce((acc, r) => acc + (r.correct_count || 0), 0);
  const avgLevel = total > 0 ? totalCorrect / total : 0;
  const members = memoryScores.filter((r) => r.wants_membership).length;

  return {
    total_games: total,
    millionaires: winners,
    avg_correct: Number(avgLevel.toFixed(1)),
    membership_requests: members,
  };
}

async function resetScores() {
  if (db) {
    try {
      db.exec('DELETE FROM scores');
    } catch (e) {
      console.warn('[millioner] reset failed on SQLite:', e.message);
    }
  }
  memoryScores.length = 0;
  if (kv.isEnabled) {
    try {
      await kv.set('synskflicka:millioner_scores', []);
    } catch (e) {
      console.warn('[kv] Failed to reset KV scores:', e.message);
    }
  }
}

function exportScoresCSV() {
  const rows = [...memoryScores].sort((a, b) => {
    if (b.correct_count !== a.correct_count) return b.correct_count - a.correct_count;
    return a.total_time - b.total_time;
  });

  const lines = [
    '\ufeffİsim;Sınıf;E-posta;Üyelik İsteği;Doğru Sayısı;Ödül;Durum;Süre (sn);Joker;Tarih',
  ];
  for (const r of rows) {
    const gLabel = GRADE_LABELS[r.grade] || r.grade || 'Hazırlık';
    const clean = (val) => String(val || '').replace(/;/g, ',');
    lines.push(
      [
        clean(r.name),
        clean(gLabel),
        clean(r.email),
        r.wants_membership ? 'Evet' : 'Hayır',
        r.correct_count,
        clean(r.prize_label),
        clean(r.status),
        r.total_time,
        r.jokers_used,
        clean(r.created_at),
      ].join(';')
    );
  }
  return lines.join('\r\n');
}

module.exports = {
  loadSettings,
  saveSettings,
  persistScore,
  getLeaderboard,
  getStats,
  resetScores,
  exportScoresCSV,
};
