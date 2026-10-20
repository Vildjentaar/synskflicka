/**
 * Kim Veri Bilimci Olmak İster? — Oyun istemcisi
 * Durum makinesi: ready → question → confirm → locked → (reveal) → question | over
 */
(() => {
  const LETTERS = ['A', 'B', 'C', 'D'];
  const $ = (id) => document.getElementById(id);
  const sfx = window.soundSynth;

  const params = new URLSearchParams(location.search);
  const sid = params.get('sid') || sessionStorage.getItem('vbt_milyoner_sid');

  let state = null;
  let config = null;
  let phase = 'loading';
  let selected = null;
  let annotations = {};       // { index: {aud: 42, llm: 87} } — mevcut soru için
  let deadline = 0;
  let timerHandle = null;
  let lastTickSecond = null;
  let pendingNext = null;     // doğru cevap sonrası bekleyen veri
  let confirmAction = null;

  const ARC_LEN = 2 * Math.PI * 52;

  // ------------------------------------------------------------------ init
  async function init() {
    if (!sid) return (location.href = 'index.html');
    try {
      [state, config] = await Promise.all([API.get(`/api/game/${sid}`), API.get('/api/config')]);
    } catch (e) {
      alert('Oyun oturumu bulunamadı. Ana sayfaya yönlendiriliyorsunuz.');
      return (location.href = 'index.html');
    }
    if (state.status !== 'playing') return (location.href = 'index.html');

    $('playerLabel').innerHTML = `🎮 Yarışmacı: ${escapeHtml(state.name)} <span class="badge-grade" style="margin-left:0.5rem;">${escapeHtml(state.grade_label || 'Hazırlık')}</span>`;
    $('readyName').textContent = state.name;
    const readyGrade = $('readyGradeBadge');
    if (readyGrade) readyGrade.textContent = `🎯 ${state.grade_label || 'Hazırlık'} Seviyesi`;
    $('timerArc').style.strokeDasharray = ARC_LEN;
    $('muteBtn').textContent = sfx.muted ? '🔇' : '🔊';
    renderAll(false);
    phase = 'ready';
  }

  $('readyBtn').addEventListener('click', async () => {
    sfx.ensureContext();
    $('readyOverlay').classList.add('hidden');
    await armQuestion();
  });

  async function armQuestion() {
    state = await API.post(`/api/game/${sid}/next`);
    annotations = {};
    selected = null;
    renderAll(true);
    phase = 'question';
    startTimer(state.time_remaining);
    sfx.startTension(state.level);
  }

  // ---------------------------------------------------------------- render
  function renderAll(animate) {
    renderQuestion(animate);
    renderJokers();
    renderLadder();
    $('guaranteedVal').textContent = state.guaranteed_prize;
    $('questionPrizeVal').textContent = state.ladder[state.level - 1].label;
    $('doubleHint').style.display = state.double_active ? 'flex' : 'none';
    $('withdrawBtn').disabled = state.level <= 1;
    $('withdrawBtn').title = state.level <= 1 ? 'İlk soruda çekilemezsin' : `${state.current_prize} Param ile çekil`;
  }

  function renderQuestion(animate) {
    const q = state.question;
    const isFinal = state.level === state.total_levels;
    $('qLevel').textContent = isFinal ? '👑 FİNAL SORUSU' : `SORU ${state.level} / ${state.total_levels}`;
    $('qCategory').textContent = q.category;
    $('qText').textContent = q.text;
    const box = $('questionBox');
    box.style.setProperty('--hex-border', isFinal ? 'rgba(255,215,0,0.85)' : 'rgba(0,240,255,0.75)');
    if (animate) { box.classList.remove('enter'); void box.offsetWidth; box.classList.add('enter'); }

    const grid = $('optionsGrid');
    let html = '';
    for (let row = 0; row < 2; row++) {
      html += '<div class="option-row">';
      for (let c = 0; c < 2; c++) {
        const i = row * 2 + c;
        html += `
          <button class="option" id="option${LETTERS[i]}" data-index="${i}" aria-label="Şık ${LETTERS[i]}">
            <div class="hex"><div class="hex-inner">
              <span class="opt-letter">${LETTERS[i]}:</span>
              <span class="opt-text">${escapeHtml(q.options[i])}</span>
              <span class="tag-slot"></span>
            </div></div>
          </button>`;
      }
      html += '</div>';
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.option').forEach(el =>
      el.addEventListener('click', () => onOptionClick(Number(el.dataset.index))));
    applyOptionStates();
  }

  function optionEl(i) { return $(`option${LETTERS[i]}`); }

  function applyOptionStates() {
    for (let i = 0; i < 4; i++) {
      const el = optionEl(i);
      if (!el) continue;
      el.classList.toggle('removed', state.removed.includes(i) && state.double_wrong !== i);
      el.classList.toggle('wrong', state.double_wrong === i);
      el.classList.toggle('disabled', state.double_wrong === i);
      el.classList.toggle('selected', selected === i);
      const slot = el.querySelector('.tag-slot');
      const a = annotations[i] || {};
      slot.innerHTML =
        (a.aud !== undefined ? `<span class="aud-tag">👥 %${a.aud}</span>` : '') +
        (a.llm !== undefined ? `<span class="llm-tag">🤖 %${a.llm}</span>` : '');
      slot.style.marginLeft = 'auto';
      slot.style.display = 'flex';
      slot.style.gap = '0.35rem';
    }
  }

  function renderJokers() {
    const bar = $('jokerBar');
    bar.innerHTML = Object.entries(state.jokers).map(([key, j]) => {
      const meta = JOKER_META[key];
      const cls = !j.unlocked ? 'locked' : (j.used ? 'used' : '');
      const active = key === 'double' && state.double_active ? 'active-double' : '';
      return `
        <button class="joker-btn ${cls} ${active}" id="joker-${key}" data-key="${key}"
                style="--j-color:${meta.color}" title="${meta.name}: ${meta.desc}"
                ${!j.unlocked || j.used ? 'disabled' : ''}>
          <span class="jb-icon">${meta.icon}</span>
          <span class="jb-name">${meta.short}</span>
          <span class="jb-lock">🔒<span>${j.unlock}. SORU</span></span>
        </button>`;
    }).join('');
    bar.querySelectorAll('.joker-btn').forEach(b => b.addEventListener('click', () => useJoker(b.dataset.key)));
  }

  function renderLadder() {
    const safe = state.safe_levels;
    $('ladderList').innerHTML = state.ladder.map((step, idx) => {
      const lvl = idx + 1;
      const cls = [
        safe.includes(lvl) ? 'safe' : '',
        lvl === state.total_levels ? 'final' : '',
        lvl < state.level ? 'passed' : '',
        lvl === state.level && state.status === 'playing' ? 'current' : '',
      ].join(' ');
      const icon = lvl === state.total_levels ? '👑' : (safe.includes(lvl) ? '🛡️' : (lvl < state.level ? '✓' : ''));
      return `<div class="ladder-step ${cls}" id="ladder-${lvl}">
        <span class="ls-num">${lvl}</span><span class="ls-prize">${step.label}</span><span class="ls-icon">${icon}</span></div>`;
    }).join('');
  }

  // ----------------------------------------------------------------- timer
  function startTimer(seconds) {
    stopTimer();
    deadline = performance.now() + seconds * 1000;
    $('timerRing').classList.remove('paused');
    lastTickSecond = null;
    timerHandle = setInterval(updateTimer, 100);
    updateTimer();
  }

  function stopTimer(paused = true) {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
    if (paused) $('timerRing').classList.add('paused');
  }

  function updateTimer() {
    const remaining = Math.max(0, (deadline - performance.now()) / 1000);
    const limit = state.time_limit;
    const sec = Math.ceil(remaining);
    $('timerText').textContent = sec;
    $('timerArc').style.strokeDashoffset = ARC_LEN * (1 - remaining / limit);
    const ring = $('timerRing');
    ring.classList.toggle('warn', remaining <= limit * 0.5 && remaining > 10);
    ring.classList.toggle('danger', remaining <= 10);
    if (sec !== lastTickSecond && sec <= 10 && sec > 0) sfx.playTick(sec <= 5);
    lastTickSecond = sec;
    if (remaining <= 0) {
      stopTimer();
      if (phase === 'question' || phase === 'confirm') {
        closeModal('confirmModal');
        submitAnswer(-1);
      }
    }
  }

  // ------------------------------------------------------------- answering
  function onOptionClick(i) {
    if (phase !== 'question' && phase !== 'confirm') return;
    if (state.removed.includes(i)) return;
    selected = i;
    applyOptionStates();
    sfx.playSelect();
    openConfirm({
      icon: state.level === state.total_levels ? '👑' : '🤔',
      title: 'Son kararın mı?',
      desc: `<strong style="color:var(--accent-amber)">${LETTERS[i]}:</strong> ${escapeHtml(state.question.options[i])}`,
      action: () => submitAnswer(i),
    });
  }

  function openConfirm({ icon, title, desc, action, yesText }) {
    phase = 'confirm';
    confirmAction = action;
    $('confirmIcon').textContent = icon;
    $('confirmTitle').textContent = title;
    $('confirmDesc').innerHTML = desc;
    $('confirmYes').innerHTML = (yesText || 'Evet, kilitle') + ' <span class="kbd">Enter</span>';
    openModal('confirmModal');
  }

  function cancelConfirm() {
    if (phase !== 'confirm') return;
    closeModal('confirmModal');
    phase = 'question';
    selected = null;
    applyOptionStates();
  }

  $('confirmNo').addEventListener('click', cancelConfirm);
  $('confirmYes').addEventListener('click', () => {
    if (phase !== 'confirm' || !confirmAction) return;
    closeModal('confirmModal');
    const fn = confirmAction;
    confirmAction = null;
    fn();
  });

  async function submitAnswer(choice) {
    phase = 'locked';
    stopTimer();
    sfx.stopTension();
    document.querySelectorAll('.option').forEach(o => o.classList.add('disabled'));
    if (choice >= 0) sfx.playLock();

    const suspense = choice < 0 ? 300 : (state.level >= 9 ? 2600 : 1700);
    let res;
    try {
      [res] = await Promise.all([
        API.post(`/api/game/${sid}/answer`, { choice }),
        new Promise(r => setTimeout(r, suspense)),
      ]);
    } catch (e) {
      showFlash('⚠️ Bağlantı hatası', e.message, 'safe');
      phase = 'question';
      document.querySelectorAll('.option').forEach(o => o.classList.remove('disabled'));
      startTimer(Math.max(3, (deadline - performance.now()) / 1000));
      return;
    }

    if (res.result === 'retry') {
      sfx.playWrong();
      state = res.state;
      selected = null;
      applyOptionStates();
      document.querySelectorAll('.option').forEach((o, i) => { if (i !== state.double_wrong) o.classList.remove('disabled'); });
      renderJokers();
      $('doubleHint').style.display = 'none';
      showFlash('🔁 İkinci Epoch!', 'Yanlış ama bir hakkın daha var', 'safe');
      phase = 'question';
      startTimer(state.time_remaining);
      sfx.startTension(state.level);
      return;
    }

    revealAnswer(res);
  }

  function revealAnswer(res) {
    const correctEl = optionEl(res.correct_index);
    document.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
    if (res.result === 'correct' || res.result === 'won') {
      correctEl.classList.add('correct');
      sfx.playCorrect();
      if (res.result === 'won') return setTimeout(() => finishGame(res), 1600);

      pendingNext = res;
      const lvlEl = $(`ladder-${state.level}`);
      if (lvlEl) { lvlEl.classList.remove('current'); lvlEl.classList.add('passed'); }
      setTimeout(() => {
        if (res.reached_safe) {
          sfx.playSafe();
          showFlash('🛡️ BARAJ GEÇİLDİ!', `${res.won_label} Param artık garanti`, 'safe');
        }
        setTimeout(() => {
          $('correctDesc').innerHTML = `<strong class="gold-text" style="font-size:1.4rem;">${res.won_label} Parametre</strong> kazandın!`;
          $('correctExplain').textContent = '💡 ' + (res.explanation || 'Harika gidiyorsun!');
          phase = 'reveal';
          openModal('correctModal');
        }, res.reached_safe ? 1800 : 0);
      }, 1300);
    } else {
      if (res.chosen !== undefined && res.chosen >= 0 && res.chosen !== res.correct_index) optionEl(res.chosen).classList.add('wrong');
      correctEl.classList.add('correct');
      if (res.result !== 'withdrawn') sfx.playWrong();
      setTimeout(() => finishGame(res), 2200);
    }
  }

  $('nextBtn').addEventListener('click', goNext);

  async function goNext() {
    if (phase !== 'reveal' || !pendingNext) return;
    closeModal('correctModal');
    phase = 'transition';
    const res = pendingNext;
    pendingNext = null;
    if (res.new_jokers && res.new_jokers.length) await showUnlock(res.new_jokers);
    await armQuestion();
    if (res.new_jokers) res.new_jokers.forEach(j => {
      const b = $(`joker-${j.key}`);
      if (b) b.classList.add('just-unlocked');
    });
  }

  // ---------------------------------------------------------------- jokers
  async function useJoker(key) {
    if (phase !== 'question') return;
    phase = 'joker';
    sfx.playJoker();
    let res;
    try {
      res = await API.post(`/api/game/${sid}/joker/${key}`);
    } catch (e) {
      showFlash('⚠️ Joker kullanılamadı', e.message, 'safe');
      phase = 'question';
      return;
    }
    const prevQuestionId = state.question.id;
    state = res.state;
    renderJokers();

    if (key === 'fifty') {
      res.removed.forEach(i => {
        const el = optionEl(i);
        el.style.transition = 'opacity 0.5s, transform 0.5s';
        el.style.opacity = '0';
        el.style.transform = 'scale(0.9)';
      });
      setTimeout(() => applyOptionStates(), 550);
      showFlash('✂️ %50 Yarı Yarıya', 'İki yanlış şık elendi');
      phase = 'question';
    } else if (key === 'audience') {
      showAudience(res.percentages);
    } else if (key === 'llm') {
      showLlm(res);
    } else if (key === 'double') {
      $('doubleHint').style.display = 'flex';
      showFlash('🔁 Çift Cevap Hakkı', 'Bu soruda iki cevap hakkın var!', 'safe');
      phase = 'question';
    }
  }

  function showAudience(pcts) {
    $('audChart').innerHTML = pcts.map((p, i) => `
      <div class="aud-col">
        <span class="aud-pct" id="audPct${i}">0%</span>
        <div class="aud-bar" id="audBar${i}" style="${state.removed.includes(i) ? 'opacity:0.25' : ''}"></div>
        <span class="aud-letter">${LETTERS[i]}</span>
      </div>`).join('');
    openModal('audienceModal');
    requestAnimationFrame(() => setTimeout(() => {
      pcts.forEach((p, i) => {
        $(`audBar${i}`).style.height = `${Math.max(2, p * 1.8)}px`;
        animateNumber($(`audPct${i}`), p, 1400, v => `${v}%`);
        annotations[i] = { ...(annotations[i] || {}), aud: p };
      });
    }, 80));
    onModalClose('audienceModal', () => { applyOptionStates(); phase = 'question'; });
  }

  function showLlm(res) {
    const term = $('llmTerminal');
    $('llmConfWrap').style.display = 'none';
    $('llmCloseBtn').disabled = true;
    $('llmConfFill').style.width = '0';
    openModal('llmModal');
    const lines = [
      `<span class="prompt">vbt@ai:~$</span> yapay-zeka --analiz "${escapeHtml(state.question.text.slice(0, 60))}${state.question.text.length > 60 ? '…' : ''}"`,
      'Bilgi tabanı taranıyor... ✓  Şıklar analiz ediliyor... ✓',
      escapeHtml(res.message),
    ];
    let li = 0, ci = 0, html = '';
    term.innerHTML = '<span class="cursor"></span>';
    const typer = setInterval(() => {
      if (li >= lines.length) {
        clearInterval(typer);
        term.innerHTML = html;
        $('llmConfWrap').style.display = 'block';
        $('llmConfVal').textContent = `%${res.confidence}`;
        $('llmDisclaimer').textContent = res.disclaimer;
        setTimeout(() => ($('llmConfFill').style.width = `${res.confidence}%`), 50);
        annotations[res.pick] = { ...(annotations[res.pick] || {}), llm: res.confidence };
        $('llmCloseBtn').disabled = false;
        return;
      }
      const line = lines[li];
      // HTML etiketlerini tek seferde geç
      if (line[ci] === '<') { const end = line.indexOf('>', ci); ci = end + 1; }
      else if (line[ci] === '&') { const end = line.indexOf(';', ci); ci = end + 1; }
      else ci++;
      if (ci % 3 === 0) sfx.playTyping();
      term.innerHTML = html + line.slice(0, ci) + '<span class="cursor"></span>';
      if (ci >= line.length) { html += line + '<br>'; li++; ci = 0; }
    }, li === 0 ? 14 : 18);
    onModalClose('llmModal', () => { applyOptionStates(); phase = 'question'; });
  }

  function showUnlock(jokers) {
    return new Promise(resolve => {
      sfx.playUnlock();
      $('unlockCards').innerHTML = jokers.map(j => {
        const m = JOKER_META[j.key];
        return `<div class="us-card" style="--j-color:${m.color}">
          <div class="uc-icon">${m.icon}</div>
          <div class="uc-name">${m.name}</div>
          <div class="uc-desc">${m.desc}</div>
        </div>`;
      }).join('');

      const splash = $('unlockSplash');
      const btn = $('unlockContinueBtn');
      splash.classList.add('active');
      phase = 'unlock';

      // Önceki modalın Enter tuşundan etkilenmemesi için butonu kısa bir süre korumaya al
      btn.disabled = true;
      btn.textContent = 'JOKER YÜKLENİYOR...';
      btn.style.opacity = '0.6';

      let canProceed = false;

      const done = () => {
        if (!canProceed) return;
        splash.classList.remove('active');
        btn.removeEventListener('click', done);
        document.removeEventListener('keydown', keyDone);
        resolve();
      };

      const keyDone = (e) => {
        if (canProceed && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          done();
        }
      };

      setTimeout(() => {
        canProceed = true;
        btn.disabled = false;
        btn.textContent = 'DEVAM ET (SORUYA GEÇ) ⚡';
        btn.style.opacity = '1';
        btn.focus();
        btn.addEventListener('click', done);
        document.addEventListener('keydown', keyDone);
      }, 700);
    });
  }

  // -------------------------------------------------------------- withdraw
  $('withdrawBtn').addEventListener('click', () => {
    if (phase !== 'question' || state.level <= 1) return;
    openConfirm({
      icon: '🏳️',
      title: 'Çekilmek istiyor musun?',
      desc: `Yarışmayı <strong class="gold-text">${state.current_prize} Parametre</strong> ile bitireceksin. Doğru cevap sonra gösterilecek.`,
      yesText: 'Evet, çekil',
      action: async () => {
        phase = 'locked';
        stopTimer();
        sfx.stopTension();
        try {
          const res = await API.post(`/api/game/${sid}/withdraw`);
          revealAnswer(res);
        } catch (e) {
          showFlash('⚠️ Hata', e.message, 'safe');
          phase = 'question';
        }
      },
    });
  });

  // ------------------------------------------------------------- game over
  function finishGame(res) {
    phase = 'over';
    state.status = res.summary.status;
    renderLadder();
    const s = res.summary;
    const titles = {
      won: ['👑', 'MİLYARDER OLDUN!', 'Tüm soruları bildin! Adın <strong class="gold-text">Milyarderler Duvarı</strong>\'na yazıldı. Ödülünü almak için stand görevlisine başvur! 🎁'],
      lost: ['💥', 'Yanlış Cevap!', 'Model bu sefer yakınsamadı. Ama her epoch bir derstir!'],
      timeout: ['⏰', 'Süre Doldu!', 'Zaman aşımı! Bir dahaki sefere daha hızlı inference 😉'],
      withdrawn: ['🏳️', 'Akıllıca Çekildin', 'Risk yönetimi de veri biliminin parçası!'],
    };
    const [icon, title, desc] = titles[s.status] || titles.lost;
    $('endIcon').textContent = icon;
    $('endTitle').innerHTML = s.status === 'won' ? `<span class="gold-text">${title}</span>` : title;
    $('endDesc').innerHTML = desc + (res.rank ? `<br><br>Liderlik tablosunda <strong style="color:var(--accent-cyan)">#${res.rank}</strong> sıradasın.` : '');
    $('endCorrect').textContent = `${s.correct_count}/${state.total_levels}`;
    $('endPrize').textContent = s.prize_label;
    $('endTime').textContent = formatDuration(s.total_time);
    if (res.explanation && s.status !== 'won') {
      $('endExplain').style.display = 'block';
      $('endExplain').textContent = `💡 Doğru cevap ${LETTERS[res.correct_index]}: ${res.explanation}`;
    }
    if (config && config.join_url) {
      $('qrImg').src = `/api/qr?t=${Date.now()}`;
      $('qrImg').onerror = () => ($('qrBox').style.display = 'none');
      $('qrBox').style.display = 'flex';
    }
    if (s.status === 'won') { sfx.playVictory(); launchConfetti(); }
    sessionStorage.removeItem('vbt_milyoner_sid');
    openModal('endModal');
  }

  // ---------------------------------------------------------------- modals
  const closeHandlers = {};
  function openModal(id) { $(id).classList.add('active'); }
  function closeModal(id) {
    $(id).classList.remove('active');
    if (closeHandlers[id]) { const fn = closeHandlers[id]; delete closeHandlers[id]; fn(); }
  }
  function onModalClose(id, fn) { closeHandlers[id] = fn; }
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));

  let flashTimer = null;
  function showFlash(title, sub = '', variant = '') {
    const el = $('flashBanner');
    el.className = `flash-banner ${variant}`;
    el.innerHTML = `${title}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}`;
    requestAnimationFrame(() => el.classList.add('active'));
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('active'), 1700);
  }

  function animateNumber(el, target, dur, fmt) {
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // -------------------------------------------------------------- confetti
  function launchConfetti() {
    const canvas = $('confettiCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = innerWidth; canvas.height = innerHeight;
    const colors = ['#00f0ff', '#a855f7', '#ffd700', '#10b981', '#f59e0b', '#ffffff'];
    const parts = Array.from({ length: 260 }, () => ({
      x: Math.random() * canvas.width, y: -20 - Math.random() * canvas.height,
      w: 6 + Math.random() * 6, h: 8 + Math.random() * 10,
      vx: -2 + Math.random() * 4, vy: 2 + Math.random() * 4,
      r: Math.random() * Math.PI, vr: -0.2 + Math.random() * 0.4,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const end = performance.now() + 7000;
    (function frame(now) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      parts.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        if (p.y > canvas.height + 20 && now < end - 2000) { p.y = -20; p.x = Math.random() * canvas.width; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      });
      if (now < end) requestAnimationFrame(frame); else ctx.clearRect(0, 0, canvas.width, canvas.height);
    })(performance.now());
  }

  // -------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (phase === 'unlock') return;
    if (k === 'm') { $('muteBtn').textContent = sfx.toggleMute() ? '🔇' : '🔊'; return; }
    if (k === 'f') { toggleFullscreen(); return; }
    if (phase === 'ready' && k === 'enter') { $('readyBtn').click(); return; }
    if ((phase === 'question' || phase === 'confirm') && ['a', 'b', 'c', 'd'].includes(k)) {
      onOptionClick(LETTERS.indexOf(k.toUpperCase()));
      return;
    }
    if (phase === 'confirm' && k === 'enter') { e.preventDefault(); $('confirmYes').click(); return; }
    if (phase === 'confirm' && k === 'escape') { cancelConfirm(); return; }
    if (phase === 'reveal' && k === 'enter') { e.preventDefault(); goNext(); return; }
    if (phase === 'joker' && (k === 'enter' || k === 'escape')) {
      if ($('audienceModal').classList.contains('active')) closeModal('audienceModal');
      else if ($('llmModal').classList.contains('active') && !$('llmCloseBtn').disabled) closeModal('llmModal');
    }
  });

  $('muteBtn').addEventListener('click', () => { $('muteBtn').textContent = sfx.toggleMute() ? '🔇' : '🔊'; });
  $('fullscreenBtn').addEventListener('click', toggleFullscreen);
  window.addEventListener('beforeunload', (e) => {
    if (phase !== 'over' && phase !== 'loading' && phase !== 'ready') { e.preventDefault(); e.returnValue = ''; }
  });

  init();
})();
