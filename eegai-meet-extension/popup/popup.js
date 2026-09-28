const $ = s => document.querySelector(s);

async function render() {
  const state = await EG.send({ type: 'getState' });
  const profile = state.profile;
  $('#signedOut').classList.toggle('hidden', !!profile);
  $('#signedIn').classList.toggle('hidden', !profile);
  if (!profile) return;

  $('#avatar').src = profile.picture || '../icons/icon48.png';
  $('#userName').textContent = profile.name;
  $('#userEmail').textContent = profile.email;
  $('#autoAdmit').checked = !!state.settings.autoAdmit;
  $('#admitHint').textContent = state.settings.admitMode === 'listed'
    ? 'Only people in your saved lists are admitted'
    : 'Admit everyone asking to join automatically';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const code = tab && EG.meetingCodeFromUrl(tab.url || '');
  const active = await EG.getLocal('activeSessions', {});
  const live = Object.values(active).find(s => tab && s.tabId === tab.id && Date.now() - s.updatedAt < 15000);
  const box = $('#meetingBox');
  box.classList.toggle('live', !!live);
  if (live) {
    const inCall = Object.values(live.participants).filter(p => { const l = p.intervals[p.intervals.length - 1]; return l && !l[1]; }).length;
    $('#meetingText').textContent = 'Tracking ' + (live.meetingName || code) + ' · ' + inCall + ' in call';
  } else if (code) {
    $('#meetingText').textContent = 'Meeting ' + code + ' — tracking starts once you join the call.';
  } else {
    $('#meetingText').textContent = 'Open a Google Meet to start tracking.';
  }
}

$('#signIn').addEventListener('click', async () => {
  $('#signInError').classList.add('hidden');
  const r = await EG.send({ type: 'signIn' });
  if (!r.ok) {
    $('#signInError').textContent = 'Sign-in failed: ' + r.error;
    $('#signInError').classList.remove('hidden');
  }
  render();
});

$('#autoAdmit').addEventListener('change', e => EG.saveSettings({ autoAdmit: e.target.checked }));

$('#openSheet').addEventListener('click', async () => {
  $('#openSheet').disabled = true;
  const r = await EG.send({ type: 'ensureSheet' });
  $('#openSheet').disabled = false;
  if (r.ok) chrome.tabs.create({ url: r.sheetUrl });
  else alert('Could not open the Google Sheet: ' + r.error);
});

document.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL(el.dataset.open) });
}));

render();
