/* Eegai G Meet Auto admin & attendance tracker — shared helpers.
 * Loaded by the service worker (importScripts), the Meet content script and every extension page. */
(function (root) {
  const EG = {};

  EG.APP_NAME = 'Eegai G Meet Auto admin & attendance tracker';
  EG.SHEET_TITLE = 'Eegai G Meet Attendance';
  EG.SHEET_TAB = 'Attendance';
  EG.REPORT_HEADERS = ['Meeting Name', 'Meeting ID', 'Date', 'Participant', 'Email', 'In Time', 'Out Time', 'Duration', 'Attendance'];
  EG.STORAGE_QUOTA = 10 * 1024 * 1024;

  EG.DEFAULT_SETTINGS = {
    autoAdmit: false,            // auto-admit people asking to join
    admitMode: 'all',            // 'all' | 'listed' (only people in a saved participant list)
    showWidget: true,            // floating control on the Meet page
    autoOpenPeoplePanel: true,   // open the People panel once so everybody is tracked
    sheetSync: true,             // append every report to the Google Sheet
    openReportOnEnd: true,       // pop up the report window when a meeting ends
    autoDownloadCsv: true,       // download the CSV automatically in that window
    includeAbsentees: true,      // add listed people who never joined as "Absent"
    minMinutesPresent: 0         // below this => "Partial"
  };

  const MEET_CODE_RE = /([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})/i;

  EG.meetingCodeFromUrl = function (url) {
    if (!url) return '';
    const s = String(url).trim();
    try {
      const u = new URL(s.includes('://') ? s : 'https://meet.google.com/' + s);
      if (u.hostname === 'meet.google.com') {
        const m = u.pathname.match(/^\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})(?:$|[/?#])/i);
        if (m) return m[1].toLowerCase();
        return '';
      }
    } catch (e) { /* fall through */ }
    const m = s.match(MEET_CODE_RE);
    return m ? m[1].toLowerCase() : '';
  };

  EG.meetingLink = code => (code ? 'https://meet.google.com/' + code : '');

  EG.normName = function (n) {
    return String(n || '')
      .replace(/\((you|host|meeting host|presentation)\)/ig, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  };

  EG.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = n => String(n).padStart(2, '0');

  EG.fmtDate = function (ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return pad(d.getDate()) + '-' + MONTHS[d.getMonth()] + '-' + d.getFullYear();
  };

  EG.fmtTime = function (ts) {
    if (!ts) return '';
    const d = new Date(ts);
    let h = d.getHours();
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + ap;
  };

  EG.fmtDateTime = ts => (ts ? EG.fmtDate(ts) + ' ' + EG.fmtTime(ts) : '');

  EG.fmtDuration = function (ms) {
    if (!ms || ms < 0) ms = 0;
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? h + ' hr ' + m + ' min ' + s + 's' : m + ' min ' + s + 's';
  };

  EG.fmtBytes = function (b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  };

  EG.escapeHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  EG.isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

  /* ---------- CSV ---------- */
  EG.toCSV = function (rows) {
    return rows.map(r => r.map(v => {
      const s = String(v == null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
  };

  EG.parseCSV = function (text) {
    const rows = [];
    let row = [], field = '', q = false;
    text = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(v => v.trim() !== '')) rows.push(row);
    return rows;
  };

  /* Turn a CSV (Name,Email in any column order, header optional) into [{name,email}] */
  EG.participantsFromCSV = function (text) {
    const rows = EG.parseCSV(text);
    if (!rows.length) return { people: [], skipped: 0 };
    let nameIdx = 0, emailIdx = 1, start = 0;
    const head = rows[0].map(h => h.trim().toLowerCase());
    const hasHeader = head.some(h => /name|mail/.test(h)) && !head.some(EG.isEmail);
    if (hasHeader) {
      start = 1;
      const ni = head.findIndex(h => /name/.test(h) && !/mail/.test(h));
      const ei = head.findIndex(h => /mail/.test(h));
      if (ni >= 0) nameIdx = ni;
      if (ei >= 0) emailIdx = ei;
    } else if (rows[0].length > 1 && EG.isEmail(rows[0][0]) && !EG.isEmail(rows[0][1])) {
      nameIdx = 1; emailIdx = 0;
    }
    const people = [];
    let skipped = 0;
    for (let i = start; i < rows.length; i++) {
      const name = (rows[i][nameIdx] || '').trim();
      const email = (rows[i][emailIdx] || '').trim();
      if (!name && !email) continue;
      if (email && !EG.isEmail(email)) { skipped++; continue; }
      people.push({ name: name || email.split('@')[0], email });
    }
    return { people, skipped };
  };

  EG.downloadText = function (filename, text, mime) {
    const blob = new Blob(['﻿' + text], { type: mime || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  /* ---------- storage ---------- */
  EG.getSettings = async function () {
    const { settings } = await chrome.storage.sync.get('settings');
    return Object.assign({}, EG.DEFAULT_SETTINGS, settings || {});
  };
  EG.saveSettings = async function (patch) {
    const s = await EG.getSettings();
    Object.assign(s, patch);
    await chrome.storage.sync.set({ settings: s });
    return s;
  };
  EG.getLocal = async (key, fallback) => {
    const o = await chrome.storage.local.get(key);
    return o[key] === undefined ? fallback : o[key];
  };
  EG.setLocal = (key, value) => chrome.storage.local.set({ [key]: value });

  /* Pick the participant list for a meeting: the one linked to its code, else the default list. */
  EG.listForMeeting = function (lists, code) {
    lists = lists || [];
    return lists.find(l => l.meetingCode && l.meetingCode === code) ||
      lists.find(l => l.isDefault) || null;
  };

  /* name -> email lookup: linked list wins, then every other list */
  EG.emailLookup = function (lists, linked) {
    const map = new Map();
    const add = l => (l.participants || []).forEach(p => {
      const k = EG.normName(p.name);
      if (k && p.email && !map.has(k)) map.set(k, p.email);
    });
    if (linked) add(linked);
    (lists || []).forEach(l => { if (l !== linked) add(l); });
    return map;
  };

  /* ---------- report building ---------- */
  EG.buildReport = function (session, lists, settings, profile) {
    settings = Object.assign({}, EG.DEFAULT_SETTINGS, settings || {});
    const endedAt = session.endedAt || Date.now();
    const linked = EG.listForMeeting(lists, session.meetingCode);
    const emails = EG.emailLookup(lists, linked);
    const minMs = (Number(settings.minMinutesPresent) || 0) * 60000;

    const participants = [];
    const seen = new Set();
    Object.values(session.participants || {}).forEach(p => {
      const intervals = (p.intervals || []).map(([a, b]) => [a, b || p.lastSeen || endedAt]);
      if (!intervals.length) return;
      const durationMs = intervals.reduce((t, [a, b]) => t + Math.max(0, b - a), 0);
      const key = EG.normName(p.name);
      seen.add(key);
      let email = p.email || emails.get(key) || '';
      if (!email && p.self && profile && profile.email) email = profile.email;
      participants.push({
        name: p.name,
        email,
        firstIn: intervals[0][0],
        lastOut: intervals[intervals.length - 1][1],
        durationMs,
        joins: intervals.length,
        intervals,
        attendance: minMs && durationMs < minMs ? 'Partial' : 'Present'
      });
    });
    participants.sort((a, b) => a.firstIn - b.firstIn);

    if (settings.includeAbsentees && linked) {
      (linked.participants || []).forEach(p => {
        const k = EG.normName(p.name);
        if (!k || seen.has(k)) return;
        seen.add(k);
        participants.push({ name: p.name, email: p.email || '', firstIn: 0, lastOut: 0, durationMs: 0, joins: 0, intervals: [], attendance: 'Absent' });
      });
    }

    return {
      id: session.id,
      meetingCode: session.meetingCode,
      meetingName: session.meetingName || session.meetingCode,
      meetingLink: EG.meetingLink(session.meetingCode),
      startedAt: session.startedAt,
      endedAt,
      generatedAt: Date.now(),
      owner: profile ? profile.email : '',
      listId: linked ? linked.id : null,
      listName: linked ? linked.name : '',
      admitted: session.admitted || [],
      participants,
      sheet: { synced: false, error: '' }
    };
  };

  EG.reportRows = function (report) {
    const date = EG.fmtDate(report.startedAt);
    return report.participants.map(p => [
      report.meetingName,
      report.meetingCode,
      date,
      p.name,
      p.email,
      p.firstIn ? EG.fmtTime(p.firstIn) : '-',
      p.lastOut ? EG.fmtTime(p.lastOut) : '-',
      p.attendance === 'Absent' ? '-' : EG.fmtDuration(p.durationMs),
      p.attendance
    ]);
  };

  EG.reportCSV = report => EG.toCSV([EG.REPORT_HEADERS].concat(EG.reportRows(report)));

  EG.reportFileName = function (report) {
    const safe = String(report.meetingName || report.meetingCode || 'meeting').replace(/[^\w\-]+/g, '_').slice(0, 40);
    return 'Eegai_Attendance_' + safe + '_' + EG.fmtDate(report.startedAt) + '.csv';
  };

  EG.sheetUrl = id => (id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : '');

  EG.send = function (msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'No response' });
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  };

  EG.toast = function (msg, isError) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 3200);
  };

  root.EG = EG;
})(typeof self !== 'undefined' ? self : this);
