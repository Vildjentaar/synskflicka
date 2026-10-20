'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOTAL_LEVELS = 12;
const SAFE_LEVELS = [4, 8];
const TIME_GRACE = 4.0;

const LADDER = [
  [1_000, '1K'],
  [2_500, '2.5K'],
  [5_000, '5K'],
  [10_000, '10K'],
  [25_000, '25K'],
  [50_000, '50K'],
  [100_000, '100K'],
  [250_000, '250K'],
  [500_000, '500K'],
  [1_000_000, '1M'],
  [10_000_000, '10M'],
  [1_000_000_000, '1 MİLYAR'],
];

function timeLimitFor(level) {
  if (level <= 4) return 30;
  if (level <= 8) return 45;
  if (level <= 11) return 60;
  return 90;
}

const JOKERS = {
  fifty: { name: '%50 Yarı Yarıya', unlock: 1 },
  audience: { name: 'Seyirciye Sor', unlock: 1 },
  llm: { name: 'Yapay Zekaya Sor', unlock: 5 },
  double: { name: 'Çift Cevap Hakkı', unlock: 9 },
};

const GRADE_LABELS = {
  hazirlik: 'Hazırlık',
  '1': '1. Sınıf',
  '2': '2. Sınıf',
  '3': '3. Sınıf',
  '4': '4. Sınıf',
};

const PROFANITY_PATTERNS = [
  'sik', 'yarrak', 'amk', 'aq', 'oç', 'piç', 'kahpe',
  'fuck', 'bitch', 'shit', 'asshole', 'dick', 'cunt',
];

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return m;
    }
  });
}

function sanitizeName(name) {
  const cleaned = escapeHtml(String(name || '').trim());
  const lower = cleaned.toLowerCase();
  for (const pat of PROFANITY_PATTERNS) {
    const rx = new RegExp(`\\b${pat}\\b`, 'i');
    if (rx.test(lower)) {
      return 'Yarışmacı_' + ((Math.abs(simpleHash(name)) % 9000) + 1000);
    }
  }
  return cleaned.slice(0, 24);
}

// Questions file path
const QUESTIONS_FILE = path.join(__dirname, '..', '..', 'millioner', 'questions.json');
let questionsCache = null;

function loadQuestions(force = false) {
  if (questionsCache === null || force) {
    try {
      const data = fs.readFileSync(QUESTIONS_FILE, 'utf8');
      questionsCache = JSON.parse(data);
    } catch (e) {
      if (questionsCache === null) questionsCache = [];
    }
  }
  return questionsCache;
}

function saveQuestions(questions) {
  questionsCache = questions;
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf8');
  } catch (e) {
    console.warn('[millioner] Could not persist questions.json to disk (read-only environment)');
  }
}

function questionsByLevel(level, grade = null) {
  const allQ = loadQuestions();
  if (grade) {
    const filtered = allQ.filter(
      (q) =>
        parseInt(q.level, 10) === level &&
        (q.grade === grade ||
          q.grade === 'all' ||
          (Array.isArray(q.grades) && q.grades.includes(grade)))
    );
    if (filtered.length > 0) return filtered;
  }
  return allQ.filter((q) => parseInt(q.level, 10) === level);
}

class GameSession {
  constructor(name, email, wantsMembership, grade = 'hazirlik') {
    this.id = crypto.randomUUID().replace(/-/g, '');
    this.name = name;
    this.email = email;
    this.grade = grade in GRADE_LABELS ? grade : 'hazirlik';
    this.wants_membership = Boolean(wantsMembership);
    this.level = 1;
    this.status = 'playing'; // playing | won | lost | timeout | withdrawn
    this.used_ids = new Set();
    this.jokers_used = [];
    this.started_at = Date.now() / 1000;
    this.finished_at = null;
    this.prize_value = 0;
    this.prize_label = '0';
    this.saved = false;
    this._loadQuestion();
  }

  _loadQuestion(excludeCurrent = false) {
    let pool = questionsByLevel(this.level, this.grade).filter((q) => !this.used_ids.has(q.id));
    if (pool.length === 0) {
      pool = questionsByLevel(this.level, this.grade);
      if (excludeCurrent && pool.length > 1 && this.question) {
        pool = pool.filter((q) => q.id !== this.question.id);
      }
    }
    if (pool.length === 0) {
      pool = questionsByLevel(this.level);
    }
    if (pool.length === 0) {
      throw new Error(`Seviye ${this.level} için soru bulunamadı`);
    }

    const q = pool[Math.floor(Math.random() * pool.length)];
    this.used_ids.add(q.id);
    this.question = q;

    const order = [0, 1, 2, 3];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    this.order = order;
    this.correct_display = order.indexOf(parseInt(q.answer, 10));
    this.removed = [];
    this.double_active = false;
    this.double_wrong = null;
    this.question_started = Date.now() / 1000;
    this.timer_armed = false;
    this.time_limit = timeLimitFor(this.level);
  }

  guaranteedPrize() {
    const safe = SAFE_LEVELS.filter((lv) => lv < this.level);
    if (safe.length === 0) return [0, '0'];
    const maxSafe = Math.max(...safe);
    return LADDER[maxSafe - 1];
  }

  currentPrize() {
    if (this.level <= 1) return [0, '0'];
    return LADDER[this.level - 2];
  }

  availableJokers() {
    const out = {};
    for (const [key, j] of Object.entries(JOKERS)) {
      out[key] = {
        name: j.name,
        unlock: j.unlock,
        unlocked: this.level >= j.unlock,
        used: this.jokers_used.includes(key),
      };
    }
    return out;
  }

  elapsedTotal() {
    const end = this.finished_at || Date.now() / 1000;
    return Number((end - this.started_at).toFixed(2));
  }

  _finish(status, prize) {
    this.status = status;
    this.prize_value = prize[0];
    this.prize_label = prize[1];
    this.finished_at = Date.now() / 1000;
  }

  publicState() {
    const q = this.question;
    const now = Date.now() / 1000;
    const remaining = Math.max(0, this.time_limit - (now - this.question_started));
    return {
      session_id: this.id,
      name: this.name,
      grade: this.grade,
      grade_label: GRADE_LABELS[this.grade] || 'Hazırlık',
      status: this.status,
      level: this.level,
      total_levels: TOTAL_LEVELS,
      safe_levels: [...SAFE_LEVELS].sort((a, b) => a - b),
      ladder: LADDER.map(([v, l]) => ({ value: v, label: l })),
      question: {
        id: q.id,
        category: q.category || 'Genel',
        text: q.question,
        options: this.order.map((i) => q.options[i]),
      },
      removed: this.removed,
      double_active: this.double_active,
      double_wrong: this.double_wrong,
      time_limit: this.time_limit,
      time_remaining: Number(remaining.toFixed(2)),
      jokers: this.availableJokers(),
      current_prize: this.currentPrize()[1],
      guaranteed_prize: this.guaranteedPrize()[1],
    };
  }

  resultSummary() {
    return {
      status: this.status,
      grade: this.grade,
      grade_label: GRADE_LABELS[this.grade] || 'Hazırlık',
      correct_count: this.status !== 'won' ? this.level - 1 : TOTAL_LEVELS,
      prize_value: this.prize_value,
      prize_label: this.prize_label,
      total_time: this.elapsedTotal(),
      jokers_used: this.jokers_used.length,
    };
  }

  answer(choice) {
    if (this.status !== 'playing') {
      throw new Error('Oyun zaten bitti');
    }

    const elapsed = Date.now() / 1000 - this.question_started;
    const timedOut = choice < 0 || elapsed > this.time_limit + TIME_GRACE;
    const correctIdx = this.correct_display;
    const explanation = this.question.explanation || '';

    if (timedOut) {
      this._finish('timeout', this.guaranteedPrize());
      return {
        result: 'timeout',
        correct_index: correctIdx,
        explanation,
        summary: this.resultSummary(),
      };
    }

    if (this.removed.includes(choice)) {
      throw new Error('Bu şık elenmiş');
    }

    if (choice === correctIdx) {
      if (this.level >= TOTAL_LEVELS) {
        this._finish('won', LADDER[LADDER.length - 1]);
        return {
          result: 'won',
          correct_index: correctIdx,
          explanation,
          summary: this.resultSummary(),
        };
      }

      const prevUnlocked = new Set(
        Object.entries(this.availableJokers())
          .filter(([, j]) => j.unlocked)
          .map(([k]) => k)
      );
      const reachedSafe = SAFE_LEVELS.includes(this.level);
      const wonLabel = LADDER[this.level - 1][1];
      this.level += 1;

      const nowUnlocked = new Set(
        Object.entries(this.availableJokers())
          .filter(([, j]) => j.unlocked)
          .map(([k]) => k)
      );
      const newJokers = Object.keys(JOKERS)
        .filter((k) => nowUnlocked.has(k) && !prevUnlocked.has(k))
        .map((k) => ({ key: k, name: JOKERS[k].name }));

      this._loadQuestion();
      return {
        result: 'correct',
        correct_index: correctIdx,
        explanation,
        won_label: wonLabel,
        reached_safe: reachedSafe,
        new_jokers: newJokers,
      };
    }

    // Wrong answer
    if (this.double_active && this.double_wrong === null) {
      this.double_wrong = choice;
      this.double_active = false;
      if (!this.removed.includes(choice)) {
        this.removed.push(choice);
      }
      return { result: 'retry', wrong_index: choice };
    }

    this._finish('lost', this.guaranteedPrize());
    return {
      result: 'wrong',
      correct_index: correctIdx,
      chosen: choice,
      explanation,
      summary: this.resultSummary(),
    };
  }

  withdraw() {
    if (this.status !== 'playing') {
      throw new Error('Oyun zaten bitti');
    }
    this._finish('withdrawn', this.currentPrize());
    return {
      result: 'withdrawn',
      correct_index: this.correct_display,
      explanation: this.question.explanation || '',
      summary: this.resultSummary(),
    };
  }

  useJoker(key) {
    if (this.status !== 'playing') throw new Error('Oyun zaten bitti');
    if (!JOKERS[key]) throw new Error('Geçersiz joker');
    if (this.jokers_used.includes(key)) throw new Error('Bu joker zaten kullanıldı');
    if (this.level < JOKERS[key].unlock) {
      throw new Error(`Bu joker ${JOKERS[key].unlock}. soruda açılır`);
    }

    this.jokers_used.push(key);
    let payload;
    if (key === 'fifty') payload = this._jokerFifty();
    else if (key === 'audience') payload = this._jokerAudience();
    else if (key === 'llm') payload = this._jokerLlm();
    else if (key === 'double') payload = this._jokerDouble();
    else throw new Error('Geçersiz joker');

    payload.joker = key;
    payload.state = this.publicState();
    return payload;
  }

  _aliveWrong() {
    return [0, 1, 2, 3].filter((i) => i !== this.correct_display && !this.removed.includes(i));
  }

  _jokerFifty() {
    const wrong = this._aliveWrong();
    const k = Math.min(2, Math.max(0, wrong.length - 1));
    const shuffled = [...wrong].sort(() => Math.random() - 0.5);
    const toRemove = shuffled.slice(0, k);
    this.removed.push(...toRemove);
    return { removed: toRemove };
  }

  _jokerAudience() {
    const alive = [0, 1, 2, 3].filter((i) => !this.removed.includes(i));
    let accuracy = Math.max(0.3, 0.82 - 0.045 * (this.level - 1));
    accuracy = Math.min(0.95, accuracy + (Math.random() * 0.16 - 0.08));

    let crowdTarget = this.correct_display;
    const wrongAlive = alive.filter((i) => i !== this.correct_display);
    if (wrongAlive.length > 0 && this.level >= 9 && Math.random() < 0.18) {
      crowdTarget = wrongAlive[Math.floor(Math.random() * wrongAlive.length)];
    }

    const votes = { 0: 0, 1: 0, 2: 0, 3: 0 };
    votes[crowdTarget] = accuracy;
    const rest = 1.0 - accuracy;
    const others = alive.filter((i) => i !== crowdTarget);
    const weights = others.map(() => Math.random() * 0.7 + 0.3);
    const tw = weights.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < others.length; i++) {
      votes[others[i]] = (rest * weights[i]) / tw;
    }
    if (others.length === 0) votes[crowdTarget] = 1.0;

    const pct = [0, 1, 2, 3].map((i) => Math.round(votes[i] * 100));
    const diff = 100 - pct.reduce((a, b) => a + b, 0);
    pct[crowdTarget] += diff;

    return { percentages: pct };
  }

  _jokerLlm() {
    let pCorrect;
    if (this.level <= 8) pCorrect = 0.88;
    else if (this.level <= 11) pCorrect = 0.72;
    else pCorrect = 0.58;

    const wrongAlive = this._aliveWrong();
    const hallucinate = wrongAlive.length > 0 && Math.random() > pCorrect;
    const pick = hallucinate
      ? wrongAlive[Math.floor(Math.random() * wrongAlive.length)]
      : this.correct_display;

    const confidence = !hallucinate
      ? Math.floor(Math.random() * 27) + 71
      : Math.floor(Math.random() * 22) + 78;

    const letter = ['A', 'B', 'C', 'D'][pick];
    const optionText = this.question.options[this.order[pick]];
    const templates = [
      `Verilerimi ve genel kültür bilgilerimi taradım. En olası cevap ${letter}: "${optionText}".`,
      `Bu soruyu analiz ettim. Mantıksal çıkarımıma göre doğru cevap ${letter} şıkkı: "${optionText}".`,
      `Yapay zeka analizime göre en tutarlı ve doğru seçenek ${letter}: "${optionText}" görünüyor.`,
    ];

    return {
      pick,
      confidence,
      message: templates[Math.floor(Math.random() * templates.length)],
      disclaimer: '⚠️ Yapay zeka modelleri bazen yanıltıcı veya hatalı cevaplar verebilir!',
    };
  }

  _jokerDouble() {
    this.double_active = true;
    return { double_active: true };
  }
}

class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create(name, email, wantsMembership, grade = 'hazirlik') {
    this._cleanup();
    const s = new GameSession(name, email, wantsMembership, grade);
    this.sessions.set(s.id, s);
    return s;
  }

  get(sid) {
    return this.sessions.get(sid) || null;
  }

  _cleanup() {
    const cutoff = Date.now() / 1000 - 3 * 3600;
    for (const [id, s] of this.sessions.entries()) {
      if (s.started_at < cutoff) this.sessions.delete(id);
    }
  }
}

const store = new SessionStore();

module.exports = {
  TOTAL_LEVELS,
  SAFE_LEVELS,
  LADDER,
  JOKERS,
  GRADE_LABELS,
  sanitizeName,
  loadQuestions,
  saveQuestions,
  questionsByLevel,
  GameSession,
  store,
};
