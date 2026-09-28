/* Eegai G Meet Auto admin & attendance tracker — Google Meet page script.
 * Tracks who is in the call (join / leave times) and auto-admits people asking to join.
 * Meet has no public API for this, so we read the page: the People panel and the video tiles. */
(function () {
  if (window.__eegaiMeetLoaded) return;
  window.__eegaiMeetLoaded = true;

  const POLL_MS = 2000;
  const MISSING_POLLS_TO_LEAVE = 2;   // person must be gone for ~4s before we log a leave
  const END_POLLS = 3;                // call UI gone for ~6s => meeting over

  let settings = Object.assign({}, EG.DEFAULT_SETTINGS);
  let profile = null;
  let lists = [];
  let session = null;
  let missing = {};
  let endStreak = 0;
  let peoplePanelOpened = false;
  let admittedCount = 0;
  let lastAdmitAt = 0;
  let viewAllClickedAt = 0;
  let widget = null;
  let lastSentJSON = '';

  /* ---------------- state ---------------- */
  async function loadState() {
    try {
      settings = await EG.getSettings();
      profile = await EG.getLocal('profile', null);
      lists = await EG.getLocal('lists', []);
    } catch (e) { /* extension reloaded */ }
    renderWidget();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) settings = Object.assign({}, EG.DEFAULT_SETTINGS, changes.settings.newValue || {});
    if (area === 'local' && changes.profile) profile = changes.profile.newValue || null;
    if (area === 'local' && changes.lists) lists = changes.lists.newValue || [];
    renderWidget();
  });

  /* ---------------- DOM helpers ---------------- */
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const textOf = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const labelOf = el => (el && el.getAttribute('aria-label')) || '';

  function currentCode() { return EG.meetingCodeFromUrl(location.href); }

  function inCall() {
    const leave = document.querySelector(
      'button[aria-label*="Leave call" i], [role="button"][aria-label*="Leave call" i], button[aria-label*="leave the call" i], [data-tooltip*="Leave call" i]'
    );
    if (leave && visible(leave)) return true;
    return document.querySelectorAll('[data-participant-id]').length > 0 && !!document.querySelector('[data-meeting-title], [data-call-id], [jscontroller][data-participant-id]');
  }

  function meetingTitle() {
    const el = document.querySelector('[data-meeting-title]');
    const t = el && el.getAttribute('data-meeting-title');
    if (t && t.trim()) return t.trim();
    const dt = document.title.replace(/^Meet\s*[-–:]\s*/i, '').trim();
    if (dt && !/^google meet$/i.test(dt) && !/^meet$/i.test(dt)) return dt;
    return currentCode();
  }

  function cleanName(raw) {
    let n = String(raw || '').split('\n')[0].replace(/\s+/g, ' ').trim();
    if (!n || n.length > 80) return null;
    if (/presentation|presenting|is presenting/i.test(n)) return null;
    const self = /\((you)\)|^you$/i.test(n);
    n = n.replace(/\((you|host|meeting host)\)/ig, '').replace(/\s+/g, ' ').trim();
    if (!n || /^you$/i.test(n)) return self && profile ? { name: profile.name, self: true } : null;
    return { name: n, self };
  }

  const isWaitingItem = el => [...el.querySelectorAll('button, [role="button"]')].some(b => /^admit\b/i.test(textOf(b) || labelOf(b)));

  function collectParticipants() {
    const found = new Map();
    // "You" in a tile and "Your Name (You)" in the panel are the same person: keep one "self" entry
    const add = (c, fromPanel) => {
      if (!c) return;
      const key = c.self ? '__self__' : EG.normName(c.name);
      if (!key) return;
      const prev = found.get(key);
      if (!prev) found.set(key, Object.assign(c, { fromPanel: !!fromPanel }));
      else if (fromPanel && !prev.fromPanel) found.set(key, Object.assign(c, { fromPanel: true }));
    };

    // 1) People panel: every participant is a listitem whose aria-label is the name
    document.querySelectorAll('[role="list"] [role="listitem"][aria-label]').forEach(li => {
      if (isWaitingItem(li)) return;
      const c = cleanName(labelOf(li));
      if (c && /\(you\)/i.test(textOf(li))) c.self = true;
      add(c, true);
    });

    // 2) Video tiles
    document.querySelectorAll('[data-participant-id]').forEach(tile => {
      const nameEl = tile.querySelector('[data-self-name], .notranslate, [jsname="EydYod"]');
      if (!nameEl) return;
      const c = cleanName(textOf(nameEl));
      if (c && nameEl.hasAttribute('data-self-name')) c.self = true;
      add(c, false);
    });
    return found;
  }

  function openPeoplePanelOnce() {
    if (peoplePanelOpened || !settings.autoOpenPeoplePanel) return;
    if (document.querySelector('[role="list"] [role="listitem"][aria-label]')) { peoplePanelOpened = true; return; }
    const btn = document.querySelector(
      'button[aria-label^="People" i], button[aria-label*="Show everyone" i], button[data-panel-id="1"], [role="button"][aria-label^="People" i]'
    );
    if (btn && visible(btn)) { btn.click(); peoplePanelOpened = true; }
  }

  /* ---------------- attendance ---------------- */
  function startSession() {
    const code = currentCode();
    session = {
      id: code + '-' + Date.now().toString(36),
      meetingCode: code,
      meetingName: meetingTitle(),
      startedAt: Date.now(),
      endedAt: null,
      participants: {},
      admitted: []
    };
    missing = {};
    endStreak = 0;
    peoplePanelOpened = false;
    admittedCount = 0;
  }

  function trackParticipants() {
    const now = Date.now();
    const present = collectParticipants();
    present.forEach((c, key) => {
      let p = session.participants[key];
      if (!p) p = session.participants[key] = { name: c.name, self: !!c.self, intervals: [], lastSeen: now };
      if (c.self && c.fromPanel) p.name = c.name; // prefer the real display name over the profile fallback
      const last = p.intervals[p.intervals.length - 1];
      if (!last || last[1]) p.intervals.push([now, null]);
      p.lastSeen = now;
      missing[key] = 0;
    });
    Object.keys(session.participants).forEach(key => {
      if (present.has(key)) return;
      const p = session.participants[key];
      const last = p.intervals[p.intervals.length - 1];
      if (!last || last[1]) return;
      missing[key] = (missing[key] || 0) + 1;
      if (missing[key] >= MISSING_POLLS_TO_LEAVE) last[1] = p.lastSeen;
    });
    const title = meetingTitle();
    if (title && title !== session.meetingCode) session.meetingName = title;
  }

  function pushSession() {
    const json = JSON.stringify(session);
    if (json === lastSentJSON) return;
    lastSentJSON = json;
    EG.send({ type: 'sessionUpdate', session: JSON.parse(json) });
  }

  function endSession() {
    if (!session) return;
    const s = session;
    session = null;
    const now = Date.now();
    s.endedAt = now;
    Object.values(s.participants).forEach(p => {
      p.intervals.forEach(iv => { if (!iv[1]) iv[1] = Math.min(now, p.lastSeen + POLL_MS); });
    });
    lastSentJSON = '';
    EG.send({ type: 'sessionEnded', session: s });
    renderWidget();
  }

  /* ---------------- auto admit ---------------- */
  function allowedNames() {
    const linked = EG.listForMeeting(lists, currentCode());
    const src = linked ? [linked] : lists;
    const set = new Set();
    src.forEach(l => (l.participants || []).forEach(p => set.add(EG.normName(p.name))));
    return set;
  }

  function requesterName(btn) {
    const aria = labelOf(btn);
    const m = aria.match(/^admit\s+(.+)$/i);
    if (m && !/^all$/i.test(m[1].trim())) return m[1].trim();
    let el = btn;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      if (el.getAttribute && el.getAttribute('role') === 'listitem' && labelOf(el)) return labelOf(el);
      const t = textOf(el);
      const w = t.match(/^(.+?)\s+(wants to join|is asking to join|asks to join)/i);
      if (w) return w[1].trim();
    }
    return '';
  }

  function runAutoAdmit() {
    if (!settings.autoAdmit || !profile || !session) return;
    const now = Date.now();
    if (now - lastAdmitAt < 700) return;
    const buttons = document.querySelectorAll('button, [role="button"]');
    const listedOnly = settings.admitMode === 'listed';
    const allowed = listedOnly ? allowedNames() : null;

    for (const b of buttons) {
      if (!visible(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      const t = (textOf(b) || labelOf(b)).toLowerCase();
      const isAll = t === 'admit all' || /^admit all\b/.test(labelOf(b).toLowerCase());
      const isOne = t === 'admit' || /^admit\s+(?!all)/.test(labelOf(b).toLowerCase());
      if (!isAll && !isOne) continue;

      if (listedOnly) {
        if (isAll) {
          // reveal the individual requests so we can admit only listed people
          if (now - viewAllClickedAt > 5000) {
            const viewAll = [...buttons].find(x => visible(x) && /^view all$/i.test(textOf(x)));
            if (viewAll) { viewAllClickedAt = now; viewAll.click(); }
          }
          continue;
        }
        const who = requesterName(b);
        if (!who || !allowed.has(EG.normName(who))) continue;
      }

      const who = isAll ? 'Everyone waiting' : (requesterName(b) || 'Guest');
      b.click();
      lastAdmitAt = now;
      admittedCount++;
      session.admitted.push({ name: who, at: now });
      renderWidget();
      return; // one click per pass; confirmation dialogs are handled on the next pass
    }
  }

  let admitTimer = null;
  const observer = new MutationObserver(() => {
    if (!settings.autoAdmit || !session || admitTimer) return;
    admitTimer = setTimeout(() => { admitTimer = null; runAutoAdmit(); }, 250);
  });

  /* ---------------- widget ---------------- */
  const ICON_ADMIT = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
  const ICON_REPORT = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>';
  const ICON_MIN = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 13H5v-2h14v2z"/></svg>';

  function buildWidget() {
    widget = document.createElement('div');
    widget.id = 'eegai-widget';
    widget.innerHTML =
      '<div class="eg-head" title="Drag to move">' +
        '<span class="eg-logo">' + ICON_CHECK + '</span>' +
        '<span class="eg-title">Eegai Meet</span>' +
        '<button class="eg-icon-btn eg-min" title="Minimise">' + ICON_MIN + '</button>' +
      '</div>' +
      '<div class="eg-body">' +
        '<div class="eg-status"><span class="eg-dot"></span><span class="eg-status-text"></span></div>' +
        '<button class="eg-admit" type="button"></button>' +
        '<div class="eg-row">' +
          '<button class="eg-link eg-reports" type="button">' + ICON_REPORT + '<span>Reports</span></button>' +
          '<button class="eg-link eg-signin" type="button">Sign in with Google</button>' +
        '</div>' +
      '</div>';
    document.documentElement.appendChild(widget);

    widget.querySelector('.eg-admit').addEventListener('click', async () => {
      if (!profile) return EG.send({ type: 'openPage', path: 'dashboard/dashboard.html#welcome' });
      settings = await EG.saveSettings({ autoAdmit: !settings.autoAdmit });
      renderWidget();
      if (settings.autoAdmit) runAutoAdmit();
    });
    widget.querySelector('.eg-reports').addEventListener('click', () => EG.send({ type: 'openPage', path: 'dashboard/dashboard.html#reports' }));
    widget.querySelector('.eg-signin').addEventListener('click', async () => {
      const r = await EG.send({ type: 'signIn' });
      if (!r.ok) EG.send({ type: 'openPage', path: 'dashboard/dashboard.html#welcome' });
    });
    widget.querySelector('.eg-min').addEventListener('click', e => {
      e.stopPropagation();
      widget.classList.toggle('eg-collapsed');
    });

    // drag
    const head = widget.querySelector('.eg-head');
    let drag = null;
    head.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      const r = widget.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      widget.style.left = Math.max(4, Math.min(window.innerWidth - widget.offsetWidth - 4, e.clientX - drag.dx)) + 'px';
      widget.style.top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + 'px';
      widget.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = null; });
  }

  function renderWidget() {
    if (!document.body) return;
    if (!settings.showWidget) { if (widget) widget.style.display = 'none'; return; }
    if (!widget) buildWidget();
    widget.style.display = '';
    const on = !!settings.autoAdmit;
    const tracking = !!session;
    const count = tracking ? Object.values(session.participants).filter(p => { const l = p.intervals[p.intervals.length - 1]; return l && !l[1]; }).length : 0;

    widget.classList.toggle('eg-tracking', tracking);
    widget.classList.toggle('eg-signed-out', !profile);
    widget.querySelector('.eg-status-text').textContent = !profile
      ? 'Sign in to track attendance'
      : tracking ? 'Tracking attendance · ' + count + ' in call' : (currentCode() ? 'Waiting for the call to start' : 'Join a meeting to start');

    const admit = widget.querySelector('.eg-admit');
    admit.classList.toggle('eg-on', on && !!profile);
    admit.setAttribute('aria-pressed', String(on));
    admit.title = on ? 'Auto admit is ON — click to turn off' : 'Click to automatically admit people asking to join';
    admit.innerHTML = ICON_ADMIT + '<span>Auto Admit: <b>' + (on ? 'ON' : 'OFF') + '</b>' +
      (on && settings.admitMode === 'listed' ? ' <small>(listed only)</small>' : '') +
      (admittedCount ? ' <small>· ' + admittedCount + ' admitted</small>' : '') + '</span>';
    widget.querySelector('.eg-signin').style.display = profile ? 'none' : '';
    widget.querySelector('.eg-reports').style.display = profile ? '' : 'none';
  }

  /* ---------------- main loop ---------------- */
  function tick() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) { clearInterval(timer); return; } // extension was reloaded
      const code = currentCode();
      const live = !!code && inCall();

      if (session && code !== session.meetingCode) endSession();

      if (!session && live && profile) startSession();

      if (session) {
        if (!live) {
          endStreak++;
          if (endStreak >= END_POLLS) endSession();
        } else {
          endStreak = 0;
          openPeoplePanelOnce();
          trackParticipants();
          runAutoAdmit();
          pushSession();
        }
      }
      renderWidget();
    } catch (e) {
      console.warn('[Eegai Meet]', e);
    }
  }

  window.addEventListener('pagehide', () => { if (session) endSession(); });

  loadState().then(() => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    tick();
  });
  const timer = setInterval(tick, POLL_MS);
})();
