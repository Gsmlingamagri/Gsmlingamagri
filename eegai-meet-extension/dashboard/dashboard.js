const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = EG.escapeHtml;
const PAGE_SIZE = 10;

let state = { profile: null, settings: EG.DEFAULT_SETTINGS, sheetUrl: '' };
let reports = [];
let lists = [];
let page = 0;
let selected = new Set();
let currentList = null; // working copy being edited

/* ================= navigation & auth gate ================= */
function showTab() {
  let tab = (location.hash || '#reports').slice(1);
  if (!['welcome', 'reports', 'lists', 'settings', 'help'].includes(tab)) tab = 'reports';
  if (!state.profile && tab !== 'help' && tab !== 'settings') tab = 'welcome'; // settings stay reachable to fix the connector
  if (state.profile && tab === 'welcome') tab = 'reports';
  $$('.page').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
}
window.addEventListener('hashchange', () => {
  if (location.hash === '#accounts') return openAccountsFromHash();
  showTab();
});
function openAccountsFromHash() {
  history.replaceState(null, '', state.profile ? '#reports' : '#welcome');
  showTab();
  chooseAccount(state.profile ? 'Switch account' : 'Sign in with Google');
}

async function loadAll() {
  state = await EG.send({ type: 'getState' });
  if (!state.ok) state = { profile: null, settings: await EG.getSettings(), sheetUrl: '' };
  reports = await EG.getLocal('reports', []);
  lists = await EG.getLocal('lists', []);
  renderAccount();
  renderReports();
  renderLists();
  renderSettings();
  if (location.hash === '#accounts') openAccountsFromHash(); else showTab();
}

function renderAccount() {
  const p = state.profile;
  $('#acctBtn').classList.toggle('hidden', !!p);
  $('#acctMenu').classList.toggle('hidden', !p);
  if (p) {
    const av = $('#acctAvatar');
    av.innerHTML = p.picture ? '<img class="ac-avatar" referrerpolicy="no-referrer" src="' + esc(p.picture) + '" alt="">' : esc((p.name || p.email).charAt(0).toUpperCase());
    $('#acctEmail').textContent = p.email;
    $('#dropName').textContent = p.name || p.email;
    $('#dropEmail').textContent = p.email;
  }
  $('#acctLine').textContent = p ? 'Signed in as ' + p.email : 'Not signed in';
  $('#connectorMissing').classList.toggle('hidden', !!state.connectorReady);
}

function afterAccountChange(profile) {
  if (profile && location.hash === '#welcome') location.hash = '#reports';
  loadAll();
}

function chooseAccount(title) {
  EG.openAccountChooser({ title, onDone: afterAccountChange });
}

async function addAccount() {
  EG.toast('Sign in to the new Gmail account in the Google window, then click Allow');
  const r = await EG.send({ type: 'addAccount' });
  if (!r.ok) return EG.toast('Could not add account: ' + r.error, true);
  EG.toast('Signed in as ' + r.profile.email);
  afterAccountChange(r.profile);
}

async function doSignOut() {
  if (!confirm('Sign out of Eegai G Meet? You can then choose another Gmail account.')) return;
  await EG.send({ type: 'signOut' });
  await loadAll();
  chooseAccount('Choose a Google account');
}

$('#acctBtn').addEventListener('click', () => chooseAccount('Sign in with Google'));
$('#welcomeSignIn').addEventListener('click', () => chooseAccount('Sign in with Google'));
$('#signOutBtn').addEventListener('click', doSignOut);
$('#switchBtn').addEventListener('click', () => chooseAccount('Switch account'));
$('#addAcctBtn').addEventListener('click', addAccount);

$('#acctChip').addEventListener('click', e => {
  e.stopPropagation();
  const open = $('#acctDrop').classList.toggle('hidden') === false;
  $('#acctChip').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', () => $('#acctDrop').classList.add('hidden'));
$('#acctDrop').addEventListener('click', e => {
  const b = e.target.closest('[data-menu]');
  if (!b) return;
  $('#acctDrop').classList.add('hidden');
  ({ switch: () => chooseAccount('Switch account'), add: addAccount, sheet: () => openSheet(), signout: doSignOut })[b.dataset.menu]();
});

async function openSheet(forceNew) {
  const r = await EG.send({ type: 'ensureSheet', forceNew: !!forceNew });
  if (!r.ok) return EG.toast('Google Sheet error: ' + r.error, true);
  state.sheetUrl = r.sheetUrl;
  window.open(r.sheetUrl, '_blank');
}
$('#openSheetLink').addEventListener('click', e => { e.preventDefault(); openSheet(); });
$('#openSheetBtn').addEventListener('click', () => openSheet());
$('#newSheetBtn').addEventListener('click', () => {
  if (confirm('Create a brand new attendance Sheet? New reports will be saved there (the old Sheet stays in your Drive).')) openSheet(true);
});

/* ================= reports ================= */
function filteredReports() {
  const q = $('#search').value.trim().toLowerCase();
  if (!q) return reports;
  return reports.filter(r => (r.meetingName || '').toLowerCase().includes(q) || (r.meetingCode || '').includes(q));
}

async function renderStorage() {
  const used = await chrome.storage.local.getBytesInUse(null);
  const pct = Math.min(100, (used / EG.STORAGE_QUOTA) * 100);
  $('#storageBar').style.width = Math.max(pct, 1) + '%';
  $('#storageText').textContent = EG.fmtBytes(used) + ' of ' + EG.fmtBytes(EG.STORAGE_QUOTA);
}

const ICON_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const ICON_SHARE = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11A2.99 2.99 0 0 0 21 5a3 3 0 1 0-5.91.7L8.04 9.81A3 3 0 1 0 6 15c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65A2.92 2.92 0 1 0 18 16.08z"/></svg>';
const ICON_OK = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
const ICON_WARN = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z"/><path fill="currentColor" d="M11 7h2v6h-2zm0 8h2v2h-2z"/></svg>';

function renderReports() {
  const list = filteredReports();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const slice = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  $('#reportCount').textContent = reports.length;
  $('#pageInfo').textContent = list.length ? (page * PAGE_SIZE + 1) + ' - ' + (page * PAGE_SIZE + slice.length) + ' of ' + list.length : '0 - 0 of 0';
  $('#prevPage').disabled = page === 0;
  $('#nextPage').disabled = page >= pages - 1;
  $('#noReports').classList.toggle('hidden', list.length > 0);

  $('#reportRows').innerHTML = slice.map((r, i) => {
    const synced = r.sheet && r.sheet.synced;
    const present = r.participants.filter(p => p.attendance !== 'Absent').length;
    return '<tr data-id="' + esc(r.id) + '">' +
      '<td><b>' + (page * PAGE_SIZE + i + 1) + '</b></td>' +
      '<td><input type="checkbox" class="sel" ' + (selected.has(r.id) ? 'checked' : '') + ' aria-label="Select"></td>' +
      '<td class="left"><span class="meeting-name"><span><span class="mname">' + esc(r.meetingName) + '</span>' +
        '<span class="code">' + esc(r.meetingCode) + '</span></span>' +
        '<button class="icon-btn rename" title="Rename meeting">' + ICON_EDIT + '</button></span></td>' +
      '<td>' + EG.fmtDate(r.startedAt) + '</td>' +
      '<td>' + EG.fmtTime(r.generatedAt) + '</td>' +
      '<td>' + EG.fmtDuration(r.endedAt - r.startedAt) + '</td>' +
      '<td><button class="icon-btn share" title="Copy report summary">' + ICON_SHARE + '</button></td>' +
      '<td>' + (synced
        ? '<span class="synced" title="Saved to Google Sheet">' + ICON_OK + '</span>'
        : '<button class="icon-btn unsynced sync" title="' + esc((r.sheet && r.sheet.error) || 'Not saved yet — click to save to Google Sheet') + '">' + ICON_WARN + '</button>') + '</td>' +
      '<td>' + present + (present !== r.participants.length ? ' <small class="muted">/ ' + r.participants.length + '</small>' : '') + '</td>' +
      '<td><button class="btn sm view">View Report</button></td>' +
      '<td><button class="btn red sm del">Delete Report</button></td>' +
      '</tr>';
  }).join('');

  $('#selectAll').checked = slice.length > 0 && slice.every(r => selected.has(r.id));
  $('#deleteSelected').classList.toggle('hidden', selected.size === 0);
  $('#deleteSelected').textContent = 'Delete selected (' + selected.size + ')';
  const on = !!state.settings.sheetSync;
  $('#autoBackup').checked = on;
  $('#autoBackupText').textContent = 'Auto Backup (' + (on ? 'enabled' : 'disabled') + ')';
  renderStorage();
}

async function saveReports() { await EG.setLocal('reports', reports); }

$('#reportRows').addEventListener('click', async e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const r = reports.find(x => x.id === tr.dataset.id);
  if (!r) return;

  if (e.target.closest('.view')) {
    chrome.windows.create({ url: chrome.runtime.getURL('report/report.html?id=' + encodeURIComponent(r.id)), type: 'popup', width: 1100, height: 760 });
  } else if (e.target.closest('.del')) {
    if (!confirm('Delete the report for "' + r.meetingName + '"? (Rows already saved in Google Sheet are kept.)')) return;
    reports = reports.filter(x => x.id !== r.id);
    selected.delete(r.id);
    await saveReports(); renderReports();
  } else if (e.target.closest('.rename')) {
    const name = prompt('Meeting name', r.meetingName);
    if (name && name.trim()) { r.meetingName = name.trim(); await saveReports(); renderReports(); }
  } else if (e.target.closest('.share')) {
    const present = r.participants.filter(p => p.attendance !== 'Absent');
    const text = r.meetingName + ' (' + r.meetingCode + ') — ' + EG.fmtDate(r.startedAt) + '\n' +
      'Duration: ' + EG.fmtDuration(r.endedAt - r.startedAt) + ' · Present: ' + present.length + '/' + r.participants.length + '\n\n' +
      r.participants.map(p => '• ' + p.name + (p.email ? ' <' + p.email + '>' : '') + ' — ' + p.attendance +
        (p.attendance !== 'Absent' ? ' (' + EG.fmtTime(p.firstIn) + ' – ' + EG.fmtTime(p.lastOut) + ', ' + EG.fmtDuration(p.durationMs) + ')' : '')).join('\n');
    await navigator.clipboard.writeText(text);
    EG.toast('Report summary copied — paste it in mail, WhatsApp or chat');
  } else if (e.target.closest('.sync')) {
    EG.toast('Saving to Google Sheet…');
    const res = await EG.send({ type: 'syncReport', id: r.id });
    reports = await EG.getLocal('reports', []);
    renderReports();
    EG.toast(res.ok ? 'Saved to Google Sheet' : 'Could not save: ' + res.error, !res.ok);
  } else if (e.target.classList.contains('sel')) {
    e.target.checked ? selected.add(r.id) : selected.delete(r.id);
    renderReports();
  }
});

$('#selectAll').addEventListener('change', e => {
  const slice = filteredReports().slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  slice.forEach(r => (e.target.checked ? selected.add(r.id) : selected.delete(r.id)));
  renderReports();
});
$('#deleteSelected').addEventListener('click', async () => {
  if (!confirm('Delete ' + selected.size + ' selected report(s)?')) return;
  reports = reports.filter(r => !selected.has(r.id));
  selected.clear();
  await saveReports(); renderReports();
});
$('#search').addEventListener('input', () => { page = 0; renderReports(); });
$('#prevPage').addEventListener('click', () => { page--; renderReports(); });
$('#nextPage').addEventListener('click', () => { page++; renderReports(); });
$('#autoBackup').addEventListener('change', async e => {
  state.settings = await EG.saveSettings({ sheetSync: e.target.checked });
  renderReports(); renderSettings();
  if (e.target.checked) $('#syncAll').click();
});
$('#syncAll').addEventListener('click', async () => {
  const pending = reports.filter(r => !r.sheet || !r.sheet.synced).length;
  if (!pending) return EG.toast('Everything is already saved to Google Sheet');
  EG.toast('Saving ' + pending + ' report(s) to Google Sheet…');
  const res = await EG.send({ type: 'syncPending' });
  reports = await EG.getLocal('reports', []);
  renderReports();
  if (!res.ok) EG.toast('Sync failed: ' + res.error, true);
  else if (!state.settings.sheetSync) EG.toast('Turn on Auto Backup to sync reports', true);
  else EG.toast(res.count + ' report(s) saved to Google Sheet');
});
$('#exportAll').addEventListener('click', () => {
  const rows = [EG.REPORT_HEADERS];
  filteredReports().slice().reverse().forEach(r => rows.push(...EG.reportRows(r)));
  if (rows.length === 1) return EG.toast('No reports to export', true);
  EG.downloadText('Eegai_All_Attendance_' + EG.fmtDate(Date.now()) + '.csv', EG.toCSV(rows));
});

/* ================= participant lists ================= */
async function downloadSample(e) {
  if (e) e.preventDefault();
  const text = await (await fetch(chrome.runtime.getURL('sample/participants_sample.csv'))).text();
  EG.downloadText('Eegai_participants_sample.csv', text.replace(/\n/g, '\r\n'));
}
['#sampleCsv', '#sampleCsv2', '#sampleCsv3'].forEach(s => $(s).addEventListener('click', downloadSample));

function renderLists() {
  $('#noLists').classList.toggle('hidden', lists.length > 0);
  $('#listCards').innerHTML = lists.map(l =>
    '<button type="button" class="list-card' + (currentList && currentList.id === l.id ? ' active' : '') + '" data-id="' + esc(l.id) + '">' +
      '<b>' + esc(l.name) + (l.isDefault ? '<span class="badge">Default</span>' : '') + '</b>' +
      '<small>' + (l.participants || []).length + ' participants' + (l.meetingCode ? ' · ' + esc(l.meetingCode) : '') + '</small>' +
    '</button>').join('');
  renderEditor();
}

function renderEditor() {
  $('#editor').classList.toggle('hidden', !currentList);
  $('#editorEmpty').classList.toggle('hidden', !!currentList);
  if (!currentList) return;
  $('#listName').value = currentList.name || '';
  $('#listLink').value = currentList.meetingLink || '';
  $('#listDefault').checked = !!currentList.isDefault;
  $('#deleteList').classList.toggle('hidden', !lists.some(l => l.id === currentList.id));
  renderPeople();
}

function renderPeople() {
  const ppl = currentList.participants;
  $('#peopleRows').innerHTML = ppl.length ? ppl.map((p, i) =>
    '<tr data-i="' + i + '"><td>' + (i + 1) + '</td>' +
    '<td class="left"><input class="input pname" value="' + esc(p.name) + '"></td>' +
    '<td class="left"><input class="input pemail" type="email" value="' + esc(p.email) + '"></td>' +
    '<td><button type="button" class="icon-btn premove" title="Remove">✕</button></td></tr>').join('')
    : '<tr><td colspan="4" class="muted">No participants yet — add them below or upload a CSV.</td></tr>';
  $('#peopleCount').textContent = ppl.length + ' participant(s)';
}

$('#listCards').addEventListener('click', e => {
  const card = e.target.closest('.list-card');
  if (!card) return;
  const l = lists.find(x => x.id === card.dataset.id);
  currentList = JSON.parse(JSON.stringify(l));
  renderLists();
});

$('#newList').addEventListener('click', () => {
  currentList = { id: EG.uid(), name: '', meetingLink: '', meetingCode: '', isDefault: lists.length === 0, participants: [], createdAt: Date.now() };
  renderLists();
  $('#listName').focus();
});

$('#peopleRows').addEventListener('input', e => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const p = currentList.participants[+tr.dataset.i];
  if (e.target.classList.contains('pname')) p.name = e.target.value;
  if (e.target.classList.contains('pemail')) p.email = e.target.value.trim();
});
$('#peopleRows').addEventListener('click', e => {
  if (!e.target.closest('.premove')) return;
  currentList.participants.splice(+e.target.closest('tr').dataset.i, 1);
  renderPeople();
});

function addPeople(people) {
  let added = 0, updated = 0;
  people.forEach(p => {
    const k = EG.normName(p.name);
    const ex = currentList.participants.find(x => (p.email && x.email && x.email.toLowerCase() === p.email.toLowerCase()) || EG.normName(x.name) === k);
    if (ex) { if (p.email) ex.email = p.email; if (p.name) ex.name = p.name; updated++; }
    else { currentList.participants.push({ name: p.name, email: p.email }); added++; }
  });
  renderPeople();
  return { added, updated };
}

$('#addPerson').addEventListener('click', () => {
  const name = $('#addName').value.trim();
  const email = $('#addEmail').value.trim();
  if (!name) return EG.toast('Enter a participant name', true);
  if (email && !EG.isEmail(email)) return EG.toast('Enter a valid mail ID', true);
  addPeople([{ name, email }]);
  $('#addName').value = ''; $('#addEmail').value = '';
  $('#addName').focus();
});
$('#addEmail').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#addPerson').click(); } });
$('#addName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#addEmail').focus(); } });

$('#csvFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const { people, skipped } = EG.participantsFromCSV(await file.text());
  if (!people.length) return EG.toast('No participants found. Use the sample CSV format: Name,Email', true);
  if ($('#csvReplace').checked) currentList.participants = [];
  if (!currentList.name) currentList.name = $('#listName').value = file.name.replace(/\.[^.]+$/, '');
  const { added, updated } = addPeople(people);
  EG.toast(added + ' added, ' + updated + ' updated' + (skipped ? ', ' + skipped + ' skipped (invalid mail ID)' : '') + ' — click Save list');
});

$('#editor').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#listName').value.trim();
  const link = $('#listLink').value.trim();
  const code = EG.meetingCodeFromUrl(link);
  if (!name) return EG.toast('Give the list a name', true);
  if (link && !code) return EG.toast('That does not look like a Google Meet link', true);
  const bad = currentList.participants.find(p => p.email && !EG.isEmail(p.email));
  if (bad) return EG.toast('Invalid mail ID: ' + bad.email, true);
  const clash = code && lists.find(l => l.meetingCode === code && l.id !== currentList.id);
  if (clash && !confirm('"' + clash.name + '" is already linked to ' + code + '. Move the link to this list?')) return;

  currentList.name = name;
  currentList.meetingLink = code ? EG.meetingLink(code) : '';
  currentList.meetingCode = code;
  currentList.isDefault = $('#listDefault').checked;
  currentList.participants = currentList.participants.filter(p => p.name.trim() || p.email);
  currentList.updatedAt = Date.now();

  lists = lists.filter(l => l.id !== currentList.id);
  if (clash) clash.meetingCode = clash.meetingLink = '';
  if (currentList.isDefault) lists.forEach(l => { l.isDefault = false; });
  lists.unshift(JSON.parse(JSON.stringify(currentList)));
  await EG.setLocal('lists', lists);
  renderLists();
  EG.toast('List saved');
});

$('#deleteList').addEventListener('click', async () => {
  if (!confirm('Delete the list "' + currentList.name + '"?')) return;
  lists = lists.filter(l => l.id !== currentList.id);
  await EG.setLocal('lists', lists);
  currentList = null;
  renderLists();
});

$('#exportList').addEventListener('click', () => {
  const rows = [['Name', 'Email']].concat(currentList.participants.map(p => [p.name, p.email]));
  EG.downloadText((currentList.name || 'participants').replace(/[^\w\-]+/g, '_') + '.csv', EG.toCSV(rows));
});

/* ================= settings ================= */
$('#saveWebAppUrl').addEventListener('click', async () => {
  const v = $('#webAppUrl').value.trim().split('?')[0].split('#')[0].replace(/\/macros\/u\/\d+\/s\//, '/macros/s/');
  if (v && /\/dev$/.test(v)) return EG.toast('That is the /dev test link. Use the Web app URL ending in /exec', true);
  if (v && !/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/.test(v)) return EG.toast('Paste the Web app URL ending in /exec', true);
  await EG.setLocal('webAppUrl', v);
  $('#webAppUrl').value = v;
  EG.toast('Connector saved');
  loadAll();
  if (v) $('#testConnector').click();
});

$('#testConnector').addEventListener('click', async () => {
  const out = $('#connectorResult');
  out.className = 'muted small';
  out.textContent = 'Testing…';
  const r = await EG.send({ type: 'testConnector' });
  out.className = 'small ' + (r.ok ? 'ok-text' : 'error');
  out.textContent = r.ok ? r.message : r.error;
});

function renderSettings() {
  EG.getLocal('webAppUrl', '').then(v => { $('#webAppUrl').value = v; });
  $$('[data-set]').forEach(el => {
    const v = state.settings[el.dataset.set];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}
$$('[data-set]').forEach(el => el.addEventListener('change', async () => {
  const key = el.dataset.set;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') v = Math.max(0, Number(v) || 0);
  state.settings = await EG.saveSettings({ [key]: v });
  renderReports();
  EG.toast('Saved');
}));
$('#clearReports').addEventListener('click', async () => {
  if (!confirm('Delete ALL reports stored in this browser? Your Google Sheet is not affected.')) return;
  reports = []; selected.clear();
  await saveReports(); renderReports();
});

/* keep in sync with the background (new reports arriving, settings toggled from Meet) */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.reports) { reports = changes.reports.newValue || []; renderReports(); }
  if (area === 'local' && changes.lists) { lists = changes.lists.newValue || []; renderLists(); }
  if (area === 'local' && changes.profile) loadAll();
  if (area === 'sync' && changes.settings) { state.settings = Object.assign({}, EG.DEFAULT_SETTINGS, changes.settings.newValue); renderSettings(); renderReports(); }
});

loadAll();
