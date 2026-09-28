/* Eegai G Meet Auto admin & attendance tracker — service worker */
importScripts('config.js', 'lib/common.js');

const STALE_SESSION_MS = 3 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

/* ---------------- Google connection (Apps Script bridge, no Cloud Console) ----------------
 * The extension talks to a Google Apps Script web app (apps-script/Code.gs) that runs as the
 * signed-in Google user. It creates and appends to that user's own attendance Sheet.
 * The browser's Google login cookies authenticate the request — no OAuth client ID needed. */
async function webAppUrl() {
  const custom = (await EG.getLocal('webAppUrl', '')).trim();
  return custom || (self.EG_CONFIG && self.EG_CONFIG.WEBAPP_URL) || '';
}

class NeedsConnect extends Error {}

async function bridge(action, payload) {
  const url = await webAppUrl();
  if (!url) throw new Error('The Google Sheet connector is not set up yet. Add the Apps Script web app URL in Settings (see README).');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, payload || {}))
    });
  } catch (e) {
    throw new Error('Network error — check your internet connection');
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    // Google returned a login / permission page instead of JSON
    throw new NeedsConnect('Please sign in with Google again to allow saving to your Sheet');
  }
  if (!data.ok) throw new Error(data.error || 'Google Sheet error');
  return data;
}

let connecting = null;

function connectInteractive() {
  if (connecting) return connecting;
  connecting = (async () => {
    const url = await webAppUrl();
    if (!url) throw new Error('The Google Sheet connector is not set up yet. Add the Apps Script web app URL in Settings (see README).');
    const win = await chrome.windows.create({ url: url + '?action=connect', type: 'popup', width: 560, height: 720, focused: true });
    let closed = false;
    const onRemoved = id => { if (id === win.id) closed = true; };
    chrome.windows.onRemoved.addListener(onRemoved);
    try {
      const started = Date.now();
      while (Date.now() - started < CONNECT_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 2500));
        try {
          const info = await bridge('ping');
          if (!closed) chrome.windows.remove(win.id).catch(() => {});
          return info;
        } catch (e) {
          if (!(e instanceof NeedsConnect)) throw e;
          if (closed) throw new Error('Sign-in window was closed before finishing');
        }
      }
      throw new Error('Sign-in timed out — please try again');
    } finally {
      chrome.windows.onRemoved.removeListener(onRemoved);
    }
  })();
  connecting.finally(() => { connecting = null; });
  return connecting;
}

async function signIn() {
  let info;
  try { info = await bridge('ping'); } catch (e) {
    if (!(e instanceof NeedsConnect)) throw e;
    info = await connectInteractive();
  }
  const email = info.email || '';
  const profile = {
    email,
    name: info.name || email.split('@')[0] || 'Google user',
    picture: '',
    sheetUrl: info.sheetUrl || '',
    signedInAt: Date.now()
  };
  await EG.setLocal('profile', profile);
  syncPending().catch(() => {});
  return profile;
}

async function signOut() {
  // We never hold Google tokens; disconnecting just forgets the account locally.
  await chrome.storage.local.remove('profile');
}

async function saveSheetUrl(sheetUrl) {
  const profile = await EG.getLocal('profile', null);
  if (profile && sheetUrl && profile.sheetUrl !== sheetUrl) {
    profile.sheetUrl = sheetUrl;
    await EG.setLocal('profile', profile);
  }
}

async function ensureSheet(forceNew) {
  const profile = await EG.getLocal('profile', null);
  if (!profile) throw new Error('Please sign in with Google first');
  const info = await bridge(forceNew ? 'newSheet' : 'ping');
  if (info.email && profile.email && info.email.toLowerCase() !== profile.email.toLowerCase()) {
    throw new Error('Your browser is now signed in to Google as ' + info.email + ', not ' + profile.email + '. Sign out and sign in again.');
  }
  await saveSheetUrl(info.sheetUrl);
  return info.sheetUrl;
}

async function appendReport(report) {
  const profile = await EG.getLocal('profile', null);
  if (!profile) throw new Error('Please sign in with Google first');
  const rows = EG.reportRows(report);
  const info = await bridge('append', { rows, expectEmail: profile.email });
  await saveSheetUrl(info.sheetUrl);
  return info.sheetUrl;
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
    const sheetUrl = await appendReport(report);
    return updateReport(id, r => { r.sheet = { synced: true, error: '', sheetUrl, at: Date.now() }; });
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
    const connectorReady = !!(await webAppUrl());
    return { profile, settings, connectorReady, sheetUrl: (profile && profile.sheetUrl) || '' };
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
    return { sheetUrl: await ensureSheet(!!msg.forceNew) };
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
