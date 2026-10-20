/**
 * Web Audio API Ses Sentezleyici — Kim Veri Bilimci Olmak İster?
 * VBT Car'daki SoundSynth ile aynı yaklaşım: harici ses dosyası yok.
 */
class SoundSynth {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('vbt_milyoner_muted') === '1';
    this.tension = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('vbt_milyoner_muted', this.muted ? '1' : '0');
    if (this.muted) this.stopTension();
    return this.muted;
  }

  _tone(freq, start, dur, { type = 'sine', vol = 0.2, slideTo = null } = {}) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur * 0.8);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(vol, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  _play(fn) {
    if (this.muted) return;
    try { this.ensureContext(); fn(this.ctx.currentTime); } catch (e) { /* autoplay */ }
  }

  playTick(urgent = false) {
    this._play(t => this._tone(urgent ? 1320 : 880, t, 0.06, { type: 'square', vol: urgent ? 0.06 : 0.03 }));
  }

  playSelect() {
    this._play(t => this._tone(660, t, 0.15, { type: 'triangle', vol: 0.18, slideTo: 990 }));
  }

  playLock() {
    // "Son kararın mı?" — gerilim tınısı
    this._play(t => {
      this._tone(220, t, 1.4, { type: 'sawtooth', vol: 0.05 });
      this._tone(233.08, t, 1.4, { type: 'sawtooth', vol: 0.05 });
      this._tone(110, t, 1.6, { type: 'sine', vol: 0.15 });
    });
  }

  playCorrect() {
    this._play(t => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        this._tone(f, t + i * 0.09, 0.45, { type: 'triangle', vol: 0.2 }));
    });
  }

  playWrong() {
    this._play(t => {
      this._tone(311, t, 0.5, { type: 'sawtooth', vol: 0.12, slideTo: 150 });
      this._tone(207, t + 0.25, 0.9, { type: 'sawtooth', vol: 0.12, slideTo: 90 });
    });
  }

  playJoker() {
    this._play(t => {
      for (let i = 0; i < 6; i++) this._tone(600 + i * 180, t + i * 0.045, 0.18, { type: 'sine', vol: 0.12 });
    });
  }

  playUnlock() {
    this._play(t => {
      [392, 523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) =>
        this._tone(f, t + i * 0.08, 0.6, { type: 'triangle', vol: 0.16 }));
      this._tone(130.8, t, 1.2, { type: 'sine', vol: 0.2 });
    });
  }

  playSafe() {
    this._play(t => {
      [523.25, 783.99, 1046.5].forEach(f => this._tone(f, t, 1.2, { type: 'triangle', vol: 0.12 }));
      [659.25, 987.77, 1318.5].forEach(f => this._tone(f, t + 0.35, 1.2, { type: 'triangle', vol: 0.12 }));
    });
  }

  playVictory() {
    this._play(t => {
      const seq = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5, 1567.98];
      seq.forEach((f, i) => this._tone(f, t + i * 0.13, 0.55, { type: 'triangle', vol: 0.2 }));
      [261.63, 329.63, 392].forEach(f => this._tone(f, t + 1.05, 2.2, { type: 'sine', vol: 0.12 }));
    });
  }

  playTyping() {
    this._play(t => this._tone(1800 + Math.random() * 600, t, 0.02, { type: 'square', vol: 0.015 }));
  }

  /** Soru boyunca seviyeye göre yükselen gerilim drone'u */
  startTension(level = 1) {
    this.stopTension();
    if (this.muted) return;
    try {
      this.ensureContext();
      const now = this.ctx.currentTime;
      const base = 55 + level * 4;
      const master = this.ctx.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.045 + level * 0.003, now + 1.5);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(320 + level * 30, now);
      const oscs = [base, base * 1.5, base * 2.003].map(f => {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f, now);
        o.connect(filter);
        o.start(now);
        return o;
      });
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      lfo.frequency.setValueAtTime(0.4 + level * 0.08, now);
      lfoGain.gain.setValueAtTime(120, now);
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start(now);
      filter.connect(master);
      master.connect(this.ctx.destination);
      this.tension = { oscs: [...oscs, lfo], master };
    } catch (e) { /* autoplay */ }
  }

  stopTension() {
    if (!this.tension || !this.ctx) return;
    const { oscs, master } = this.tension;
    const now = this.ctx.currentTime;
    try {
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
      oscs.forEach(o => o.stop(now + 0.45));
    } catch (e) {}
    this.tension = null;
  }
}

window.soundSynth = new SoundSynth();
