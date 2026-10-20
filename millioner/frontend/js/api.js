/**
 * Ortak yardımcılar: API istemcisi + joker meta verileri
 */
const API = {
  async request(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    let data = null;
    try { data = await resp.json(); } catch (e) { /* boş yanıt */ }
    if (!resp.ok) {
      const msg = (data && (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))) || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body ?? {}); },
  del(url) { return this.request('DELETE', url); },
};

const JOKER_META = {
  fifty: {
    icon: '✂️', short: '%50', color: '#00f0ff',
    name: '%50 Yarı Yarıya',
    desc: 'İki yanlış şıkkı eler, geriye 1 doğru 1 yanlış şık kalır.',
  },
  audience: {
    icon: '👥', short: 'Seyirci', color: '#10b981',
    name: 'Seyirciye Sor',
    desc: 'Salondaki seyircilerin oylama dağılımını gösterir.',
  },
  llm: {
    icon: '🤖', short: 'Yapay Zeka', color: '#a855f7',
    name: 'Yapay Zekaya Sor',
    desc: 'Yapay zeka asistanı en olası cevabı ve güven skorunu söyler.',
  },
  double: {
    icon: '🔁', short: 'Çift Cevap', color: '#ef4444',
    name: 'Çift Cevap Hakkı',
    desc: 'Bu soruda iki kez cevap verme hakkı tanır. İlkinde yanılırsan ikinci şansın olur.',
  },
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function formatDuration(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return m > 0 ? `${m}:${s}` : `${(sec).toFixed(1)}s`;
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen && document.exitFullscreen();
}
