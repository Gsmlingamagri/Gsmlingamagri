/* Eegai G Meet Auto admin & attendance tracker — service worker */
importScripts('config.js', 'lib/common.js');

const STALE_SESSION_MS = 3 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

/* ---------------- Google connection (Apps Script bridge, no Cloud Console) ----------------
 * The extension talks to a Google Apps Script web app (apps-script/Code.gs) that runs as the
 * signed-in Google user and writes to that user's own attendance Sheet. The browser's Google
 * login cookies authenticate the request, so no OAuth client ID is needed.
 *
 * Multiple accounts: Google numbers the accounts signed in to the browser (0, 1, 2 …).
 * The web app is reached as a specific account through /macros/u/<index>/s/<id>/exec, and
 * accounts.google.com/ListAccounts tells us which email sits at which index. */
const NOT_CONFIGURED = 'The Google Sheet connector is not set up yet. Add the Apps Script web app URL in Settings (see README).';

async function webAppUrl() {
  const custom = (await EG.getLocal('webAppUrl', '')).trim();
  return custom || (self.EG_CONFIG && self.EG_CONFIG.WEBAPP_URL) || '';
}

/* https://script.google.com/macros/s/ID/exec -> https://script.google.com/macros/u/N/s/ID/exec */
function urlForIndex(url, index) {
  if (index == null || index < 0) return url;
  return url
    .replace(/\/macros\/u\/\d+\/s\//, '/macros/s/')
    .replace(/\/macros\/s\//, '/macros/u/' + index + '/s/');
}

class NeedsConnect extends Error {}

/* Google accounts currently signed in to this browser, in Google's own order (= authuser index). */
let accountsCache = { at: 0, list: null };
async function listGoogleAccounts(fresh) {
  if (!fresh && accountsCache.list && Date.now() - accountsCache.at < 30000) return accountsCache.list;
  let list = null;
  try {
    const res = await fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', { credentials: 'include' });
    const data = JSON.parse(await res.text());
    const rows = Array.isArray(data) ? data.find(x => Array.isArray(x)) || [] : [];
    // rows come in Google's account order, which is the /u/<index>/ number
    list = rows.filter(r => Array.isArray(r) && EG.isEmail(r[3])).map((r, i) => ({
      index: i,
      name: r[2] || r[3].split('@')[0],
      email: String(r[3]).toLowerCase(),
      photo: typeof r[4] === 'string' ? r[4] : ''
    }));
  } catch (e) {
    list = null; // unknown — caller falls back to the default account
  }
  accountsCache = { at: Date.now(), list };
  return list;
}

async function indexForEmail(email, fresh) {
  const list = await listGoogleAccounts(fresh);
  if (!list) return null; // can't tell; use the stored index
  const hit = list.find(a => a.email === String(email).toLowerCase());
  return hit ? hit.index : -1;
}

async function bridgeAt(index, action, payload) {
  const base = await webAppUrl();
  if (!base) throw new Error(NOT_CONFIGURED);
  let res;
  try {
    res = await fetch(urlForIndex(base, index), {
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

/* Call the connector as a saved account, finding its current index first. */
async function bridgeAs(account, action, payload) {
  let index = await indexForEmail(account.email);
  if (index === -1) {
    index = await indexForEmail(account.email, true);
    if (index === -1) throw new Error(account.email + ' is signed out of Google in this browser. Use "Switch account" to sign in again.');
  }
  if (index == null) index = account.index || 0;
  const data = await bridgeAt(index, action, Object.assign({ expectEmail: account.email }, payload || {}));
  if (data.email && data.email.toLowerCase() !== account.email.toLowerCase()) {
    throw new Error('Google answered as ' + data.email + ' instead of ' + account.email + '. Use "Switch account" to reconnect.');
  }
  if (index !== account.index) await saveAccount(Object.assign({}, account, { index }));
  return data;
}

/* ---------- saved accounts ---------- */
async function getAccounts() { return EG.getLocal('accounts', []); }

async function saveAccount(acc) {
  const accounts = await getAccounts();
  const i = accounts.findIndex(a => a.email === acc.email);
  if (i >= 0) accounts[i] = Object.assign({}, accounts[i], acc); else accounts.push(acc);
  await EG.setLocal('accounts', accounts);
  const profile = await EG.getLocal('profile', null);
  if (profile && profile.email === acc.email) await EG.setLocal('profile', Object.assign({}, profile, acc));
  return i >= 0 ? accounts[i] : acc;
}

async function activate(acc) {
  const saved = await saveAccount(acc);
  await EG.setLocal('profile', Object.assign({}, saved, { signedInAt: Date.now() }));
  syncPending().catch(() => {});
  return saved;
}

/* ---------- interactive connect ---------- */
let connecting = null;

/* Opens a Google window at `startUrl` and waits until `probe()` succeeds (or the window closes). */
function waitInWindow(startUrl, probe) {
  if (connecting) return connecting;
  connecting = (async () => {
    const win = await chrome.windows.create({ url: startUrl, type: 'popup', width: 560, height: 720, focused: true });
    let closed = false;
    const onRemoved = id => { if (id === win.id) closed = true; };
    chrome.windows.onRemoved.addListener(onRemoved);
    try {
      const started = Date.now();
      while (Date.now() - started < CONNECT_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 2500));
        const result = await probe(win).catch(e => { if (e instanceof NeedsConnect) return null; throw e; });
        if (result) {
          if (!closed) chrome.windows.remove(win.id).catch(() => {});
          return result;
        }
        if (closed) throw new Error('The Google window was closed before finishing');
      }
      throw new Error('Sign-in timed out — please try again');
    } finally {
      chrome.windows.onRemoved.removeListener(onRemoved);
    }
  })();
  connecting.finally(() => { connecting = null; });
  return connecting;
}

function accountFrom(info, index, g) {
  const email = String(info.email || (g && g.email) || '').toLowerCase();
  return {
    email,
    index,
    name: (g && g.name) || email.split('@')[0] || 'Google user',
    picture: (g && g.photo) || '',
    sheetUrl: info.sheetUrl || ''
  };
}

/* Connect (or switch to) the Google account at browser index `index`. */
async function connectIndex(index) {
  const base = await webAppUrl();
  if (!base) throw new Error(NOT_CONFIGURED);
  const list = await listGoogleAccounts(true);
  const g = list && list.find(a => a.index === index);
  let info;
  try {
    info = await bridgeAt(index, 'ping', g ? { expectEmail: g.email } : {});
  } catch (e) {
    if (!(e instanceof NeedsConnect)) throw e;
    info = await waitInWindow(urlForIndex(base, index) + '?action=connect', () => bridgeAt(index, 'ping'));
  }
  if (g && info.email && info.email.toLowerCase() !== g.email) {
    throw new Error('Google answered as ' + info.email + ' instead of ' + g.email + '. Please try again.');
  }
  return activate(accountFrom(info, index, g));
}

/* Sign in to an extra Google account in the browser, then connect it. */
async function addGoogleAccount() {
  const base = await webAppUrl();
  if (!base) throw new Error(NOT_CONFIGURED);
  const before = (await listGoogleAccounts(true)) || [];
  const known = new Set(before.map(a => a.email));
  const guess = before.length; // Google normally gives the new account the next index
  const cont = urlForIndex(base, guess) + '?action=connect';
  let redirected = false;

  const result = await waitInWindow(
    'https://accounts.google.com/AddSession?continue=' + encodeURIComponent(cont),
    async win => {
      const now = await listGoogleAccounts(true);
      const added = now && now.find(a => !known.has(a.email));
      if (!added) return null;
      if (added.index !== guess && !redirected) {
        // Google put the new account at a different index: send the window to the right connect page
        redirected = true;
        const [tab] = await chrome.tabs.query({ windowId: win.id });
        if (tab) chrome.tabs.update(tab.id, { url: urlForIndex(base, added.index) + '?action=connect' });
      }
      const info = await bridgeAt(added.index, 'ping', { expectEmail: added.email });
      return { info, added };
    }
  );
  return activate(accountFrom(result.info, result.added.index, result.added));
}

/* First sign-in / "Sign in with Google": use the browser's default Google account. */
async function signIn() {
  const list = await listGoogleAccounts(true);
  if (list && !list.length) return addGoogleAccount();
  return connectIndex(list && list.length ? list[0].index : 0);
}

async function switchAccount(email) {
  const index = await indexForEmail(email, true);
  if (index === -1) throw new Error(email + ' is no longer signed in to Google in this browser. Choose "Add another account".');
  return connectIndex(index == null ? 0 : index);
}

async function signOut(forget) {
  // We never hold Google tokens; signing out forgets the active account in the extension.
  const profile = await EG.getLocal('profile', null);
  if (profile && forget) {
    const accounts = (await getAccounts()).filter(a => a.email !== profile.email);
    await EG.setLocal('accounts', accounts);
  }
  await chrome.storage.local.remove('profile');
}

async function accountOverview() {
  const [google, saved, profile] = await Promise.all([listGoogleAccounts(true), getAccounts(), EG.getLocal('profile', null)]);
  return {
    google, // null when Google's account list could not be read
    saved,
    active: profile ? profile.email : ''
  };
}

/* ---------- sheet operations ---------- */
async function activeAccount() {
  const profile = await EG.getLocal('profile', null);
  if (!profile) throw new Error('Please sign in with Google first');
  return profile;
}

async function ensureSheet(forceNew) {
  const acc = await activeAccount();
  const info = await bridgeAs(acc, forceNew ? 'newSheet' : 'ping');
  await saveAccount({ email: acc.email, sheetUrl: info.sheetUrl });
  return info.sheetUrl;
}

/* A report is saved to the Sheet of the account that recorded it (if still connected), else the active one. */
async function appendReport(report) {
  const active = await activeAccount();
  const owner = report.owner && (await getAccounts()).find(a => a.email === report.owner);
  const acc = owner || active;
  const info = await bridgeAs(acc, 'append', { rows: EG.reportRows(report) });
  await saveAccount({ email: acc.email, sheetUrl: info.sheetUrl });
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
  async signOut(msg) { await signOut(!!msg.forget); return {}; },
  async accounts() { return await accountOverview(); },
  async connectIndex(msg) { return { profile: await connectIndex(Number(msg.index) || 0) }; },
  async switchAccount(msg) { return { profile: await switchAccount(msg.email) }; },
  async addAccount() { return { profile: await addGoogleAccount() }; },
  async forgetAccount(msg) {
    await EG.setLocal('accounts', (await getAccounts()).filter(a => a.email !== msg.email));
    return {};
  },
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
