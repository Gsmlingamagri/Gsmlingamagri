const $ = s => document.querySelector(s);
const esc = EG.escapeHtml;
const params = new URLSearchParams(location.search);
const reportId = params.get('id');
const justEnded = params.get('ended') === '1';
let report = null;
let syncOn = true;

async function load() {
  const reports = await EG.getLocal('reports', []);
  report = reports.find(r => r.id === reportId) || null;
  syncOn = !!(await EG.getSettings()).sheetSync;
  render();
}

function render() {
  if (!report) {
    $('#missing').classList.remove('hidden');
    document.querySelectorAll('.cards, .bar, .table-wrap').forEach(el => el.classList.add('hidden'));
    return;
  }
  document.title = report.meetingName + ' — Attendance';
  $('#title').textContent = report.meetingName;
  $('#subtitle').innerHTML = 'Meeting ID <b>' + esc(report.meetingCode) + '</b> · <a href="' + esc(report.meetingLink) + '" target="_blank" rel="noopener">' + esc(report.meetingLink) + '</a>' +
    (report.listName ? ' · List: <b>' + esc(report.listName) + '</b>' : '');
  $('#cDate').textContent = EG.fmtDate(report.startedAt);
  $('#cTime').textContent = EG.fmtTime(report.startedAt) + ' – ' + EG.fmtTime(report.endedAt);
  $('#cDuration').textContent = EG.fmtDuration(report.endedAt - report.startedAt);
  const absent = report.participants.filter(p => p.attendance === 'Absent').length;
  $('#cPresent').textContent = report.participants.length - absent;
  $('#cAbsent').textContent = absent;
  const synced = report.sheet && report.sheet.synced;
  $('#cSheet').textContent = synced ? 'Saved ✓' : (report.sheet && report.sheet.error ? 'Not saved' : syncOn ? 'Saving…' : 'Auto Backup off');
  $('#cSheet').className = synced ? 'ok' : (report.sheet && report.sheet.error ? 'bad' : '');
  $('#cSheet').title = (report.sheet && report.sheet.error) || '';
  $('#syncBtn').classList.toggle('hidden', !!synced);

  const q = $('#filter').value.trim().toLowerCase();
  const rows = report.participants.filter(p => !q || p.name.toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q));
  $('#rows').innerHTML = rows.map((p, i) => {
    const cls = p.attendance.toLowerCase();
    const sessions = p.intervals && p.intervals.length > 1
      ? '<span class="joins">' + p.intervals.map(([a, b]) => EG.fmtTime(a) + '–' + EG.fmtTime(b)).join(', ') + '</span>' : '';
    return '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td class="left"><b>' + esc(p.name) + '</b>' + sessions + '</td>' +
      '<td class="left">' + (p.email ? esc(p.email) : '<span class="muted">—</span>') + '</td>' +
      '<td>' + (p.firstIn ? EG.fmtTime(p.firstIn) : '-') + '</td>' +
      '<td>' + (p.lastOut ? EG.fmtTime(p.lastOut) : '-') + '</td>' +
      '<td>' + (p.attendance === 'Absent' ? '-' : EG.fmtDuration(p.durationMs)) + '</td>' +
      '<td>' + (p.joins || 0) + '</td>' +
      '<td><span class="tag ' + cls + '">' + esc(p.attendance) + '</span></td>' +
      '</tr>';
  }).join('');

  const adm = report.admitted || [];
  $('#admitted').textContent = adm.length ? 'Auto Admit let in: ' + adm.map(a => a.name + ' (' + EG.fmtTime(a.at) + ')').join(', ') : '';
}

function downloadCsv() {
  EG.downloadText(EG.reportFileName(report), EG.reportCSV(report));
}

$('#downloadCsv').addEventListener('click', () => report && downloadCsv());
$('#printBtn').addEventListener('click', () => window.print());
$('#filter').addEventListener('input', render);

$('#openSheet').addEventListener('click', async () => {
  const r = await EG.send({ type: 'ensureSheet' });
  if (r.ok) window.open(r.sheetUrl, '_blank');
  else EG.toast('Google Sheet error: ' + r.error, true);
});

$('#syncBtn').addEventListener('click', async () => {
  $('#syncBtn').disabled = true;
  const r = await EG.send({ type: 'syncReport', id: report.id });
  $('#syncBtn').disabled = false;
  EG.toast(r.ok ? 'Saved to Google Sheet' : 'Could not save: ' + r.error, !r.ok);
  load();
});

$('#saveList').addEventListener('click', async () => {
  const name = prompt('Save these participants as a list. List name:', report.meetingName);
  if (!name || !name.trim()) return;
  const lists = await EG.getLocal('lists', []);
  const people = report.participants.map(p => ({ name: p.name, email: p.email || '' }));
  let list = lists.find(l => l.meetingCode === report.meetingCode);
  if (list && confirm('Add these participants to the list "' + list.name + '" already linked to this meeting?\n(Cancel to create a new list.)')) {
    people.forEach(p => {
      if (!list.participants.some(x => EG.normName(x.name) === EG.normName(p.name))) list.participants.push(p);
    });
    list.updatedAt = Date.now();
  } else {
    lists.unshift({
      id: EG.uid(), name: name.trim(), participants: people, createdAt: Date.now(), isDefault: false,
      meetingCode: list ? '' : report.meetingCode, meetingLink: list ? '' : report.meetingLink
    });
  }
  await EG.setLocal('lists', lists);
  EG.toast('Participants saved — add their mail IDs under Participant Lists');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.reports) {
    report = (changes.reports.newValue || []).find(r => r.id === reportId) || null;
    render();
  }
});

load().then(async () => {
  if (!report || !justEnded) return;
  const settings = await EG.getSettings();
  $('#endedBanner').classList.remove('hidden');
  if (settings.autoDownloadCsv) {
    downloadCsv();
    $('#bannerExtra').textContent = ' and the CSV has been downloaded';
  }
  if (settings.sheetSync) $('#bannerExtra').textContent += ($('#bannerExtra').textContent ? ';' : '') + ' rows are being added to your Google Sheet';
});
