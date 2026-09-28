/* Eegai G Meet Auto admin & attendance tracker — service worker */
importScripts('lib/common.js');

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const STALE_SESSION_MS = 3 * 60 * 1000;

/* ---------------- auth ---------------- */
function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: !!interactive }, result => {
      const err = chrome.runtime.lastError;
      const token = result && typeof result === 'object' ? result.token : result;
      if (err || !token) reject(new Error((err && err.message) || 'Not signed in'));
      else resolve(token);
    });
  });
}

function dropToken(token) {
  return new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

async function googleFetch(url, options = {}, retried) {
  const token = await getToken(false);
  const res = await fetch(url, Object.assign({}, options, {
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, options.headers || {})
  }));
  if (res.status === 401 && !retried) {
    await dropToken(token);
    return googleFetch(url, options, true);
  }
  return res;
}

async function signIn() {
  const token = await getToken(true);
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Could not read your Google profile (' + res.status + ')');
  const info = await res.json();
  const profile = { email: info.email, name: info.name || info.email, picture: info.picture || '', signedInAt: Date.now() };
  await EG.setLocal('profile', profile);
  ensureSheet().catch(() => {});
  syncPending().catch(() => {});
  return profile;
}

async function signOut() {
  try {
    const token = await getToken(false);
    await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {});
    await dropToken(token);
  } catch (e) { /* already signed out */ }
  if (chrome.identity.clearAllCachedAuthTokens) await chrome.identity.clearAllCachedAuthTokens();
  await chrome.storage.local.remove('profile');
}

/* ---------------- Google Sheet ---------------- */
async function sheetIdFor(email) {
  const sheets = await EG.getLocal('sheets', {});
  return sheets[email] || '';
}

async function createSheet(email) {
  const res = await googleFetch(SHEETS_API, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: EG.SHEET_TITLE },
      sheets: [{ properties: { title: EG.SHEET_TAB, gridProperties: { frozenRowCount: 1 } } }]
    })
  });
  if (!res.ok) throw new Error('Could not create Google Sheet (' + res.status + ')');
  const data = await res.json();
  const id = data.spreadsheetId;
  const tabId = data.sheets[0].properties.sheetId;

  await googleFetch(SHEETS_API + '/' + id + '/values/' + EG.SHEET_TAB + '!A1:I1?valueInputOption=RAW', {
    method: 'PUT', body: JSON.stringify({ values: [EG.REPORT_HEADERS] })
  });
  await googleFetch(SHEETS_API + '/' + id + ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId: tabId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.1, green: 0.53, blue: 0.31 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
            fields: 'userEnteredFormat(backgroundColor,textFormat)'
          }
        },
        { autoResizeDimensions: { dimensions: { sheetId: tabId, dimension: 'COLUMNS', startIndex: 0, endIndex: 9 } } }
      ]
    })
  }).catch(() => {});

  const sheets = await EG.getLocal('sheets', {});
  sheets[email] = id;
  await EG.setLocal('sheets', sheets);
  return id;
}

async function ensureSheet(forceNew) {
  const profile = await EG.getLocal('profile', null);
  if (!profile) throw new Error('Please sign in with Google first');
  let id = forceNew ? '' : await sheetIdFor(profile.email);
  if (id) {
    const res = await googleFetch(SHEETS_API + '/' + id + '?fields=spreadsheetId');
    if (res.ok) return id;
    if (res.status !== 404 && res.status !== 403) throw new Error('Google Sheets error (' + res.status + ')');
  }
  return createSheet(profile.email);
}

async function appendReport(report) {
  const id = await ensureSheet();
  const rows = EG.reportRows(report);
  if (!rows.length) return id;
  const url = SHEETS_API + '/' + id + '/values/' + EG.SHEET_TAB + '!A:I:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
  const res = await googleFetch(url, { method: 'POST', body: JSON.stringify({ values: rows }) });
  if (!res.ok) throw new Error('Could not write to Google Sheet (' + res.status + ')');
  return id;
}

/* ---------------- reports ---------------- */
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

async function updateReport(id, mutate) {
  const reports = await EG.getLocal('reports', []);
  const r = reports.find(x => x.id === id);
  if (!r) return null;
  mutate(r);
  await EG.setLocal('reports', reports);
  return r;
}

async function syncReport(id) {
  const reports = await EG.getLocal('reports', []);
  const report = reports.find(r => r.id === id);
  if (!report) throw new Error('Report not found');
  try {
    const sheetId = await appendReport(report);
    return updateReport(id, r => { r.sheet = { synced: true, error: '', sheetId, at: Date.now() }; });
  } catch (e) {
    await updateReport(id, r => { r.sheet = { synced: false, error: e.message }; });
    throw e;
  }
}

async function syncPending() {
  const settings = await EG.getSettings();
  const profile = await EG.getLocal('profile', null);
  if (!settings.sheetSync || !profile) return 0;
  const reports = await EG.getLocal('reports', []);
  let n = 0;
  for (const r of reports.filter(x => !x.sheet || !x.sheet.synced).reverse()) {
    try { await syncReport(r.id); n++; } catch (e) { break; }
  }
  return n;
}

function finalizeSession(session, openWindow) {
  return serial(async () => {
    const active = await EG.getLocal('activeSessions', {});
    delete active[session.id];
    await EG.setLocal('activeSessions', active);

    const reports = await EG.getLocal('reports', []);
    if (reports.some(r => r.id === session.id)) return null;
    const hasPeople = Object.values(session.participants || {}).some(p => (p.intervals || []).length);
    if (!hasPeople) return null;

    const [settings, lists, profile] = await Promise.all([EG.getSettings(), EG.getLocal('lists', []), EG.getLocal('profile', null)]);
    const report = EG.buildReport(session, lists, settings, profile);
    reports.unshift(report);
    await EG.setLocal('reports', reports);

    if (settings.openReportOnEnd && openWindow !== false) {
      chrome.windows.create({
        url: chrome.runtime.getURL('report/report.html?id=' + encodeURIComponent(report.id) + '&ended=1'),
        type: 'popup', width: 1100, height: 760, focused: true
      });
    }
    if (settings.sheetSync && profile) syncReport(report.id).catch(() => {});
    return report;
  });
}

/* Meet tab closed or browser restarted while a meeting was running */
async function finalizeWhere(pred) {
  const active = await EG.getLocal('activeSessions', {});
  for (const s of Object.values(active)) {
    if (pred(s)) {
      s.endedAt = s.endedAt || s.updatedAt || Date.now();
      Object.values(s.participants || {}).forEach(p => {
        (p.intervals || []).forEach(iv => { if (!iv[1]) iv[1] = p.lastSeen || s.endedAt; });
      });
      await finalizeSession(s, true);
    }
  }
}

chrome.tabs.onRemoved.addListener(tabId => { finalizeWhere(s => s.tabId === tabId); });

/* ---------------- lifecycle ---------------- */
chrome.runtime.onInstalled.addListener(async details => {
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) await chrome.storage.sync.set({ settings: EG.DEFAULT_SETTINGS });
  chrome.alarms.create('eg-sync', { periodInMinutes: 15 });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('eg-sync', { periodInMinutes: 15 });
  finalizeWhere(s => Date.now() - (s.updatedAt || 0) > STALE_SESSION_MS);
  syncPending().catch(() => {});
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== 'eg-sync') return;
  finalizeWhere(s => Date.now() - (s.updatedAt || 0) > STALE_SESSION_MS);
  syncPending().catch(() => {});
});

/* ---------------- messages ---------------- */
const handlers = {
  async getState() {
    const [profile, settings] = await Promise.all([EG.getLocal('profile', null), EG.getSettings()]);
    const sheetId = profile ? await sheetIdFor(profile.email) : '';
    return { profile, settings, sheetUrl: EG.sheetUrl(sheetId) };
  },
  async signIn() { return { profile: await signIn() }; },
  async signOut() { await signOut(); return {}; },
  async sessionUpdate(msg, sender) {
    const s = msg.session;
    s.tabId = sender.tab ? sender.tab.id : s.tabId;
    s.updatedAt = Date.now();
    await serial(async () => {
      const reports = await EG.getLocal('reports', []);
      if (reports.some(r => r.id === s.id)) return; // already finalized
      const active = await EG.getLocal('activeSessions', {});
      active[s.id] = s;
      await EG.setLocal('activeSessions', active);
    });
    return {};
  },
  async sessionEnded(msg, sender) {
    const s = msg.session;
    s.tabId = sender.tab ? sender.tab.id : s.tabId;
    const report = await finalizeSession(s, true);
    return { reportId: report ? report.id : null };
  },
  async syncReport(msg) { const r = await syncReport(msg.id); return { report: r }; },
  async syncPending() { return { count: await syncPending() }; },
  async ensureSheet(msg) {
    const id = await ensureSheet(!!msg.forceNew);
    return { sheetUrl: EG.sheetUrl(id) };
  },
  async openPage(msg) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(msg.path || 'dashboard/dashboard.html') });
    return {};
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  h(msg, sender)
    .then(res => sendResponse(Object.assign({ ok: true }, res)))
    .catch(e => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});
