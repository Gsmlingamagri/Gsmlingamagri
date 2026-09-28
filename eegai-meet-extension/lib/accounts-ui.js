/* Google account chooser: switch account, add another account, sign out. */
(function () {
  const esc = EG.escapeHtml;

  function avatar(a) {
    if (a.photo || a.picture) return '<img class="ac-avatar" referrerpolicy="no-referrer" src="' + esc(a.photo || a.picture) + '" alt="">';
    const letter = (a.name || a.email || '?').trim().charAt(0).toUpperCase();
    return '<span class="ac-avatar ac-letter">' + esc(letter) + '</span>';
  }

  let modal = null;

  function close() { if (modal) { modal.remove(); modal = null; } }

  /* opts: { title, onDone(profile|null) } */
  EG.openAccountChooser = async function (opts) {
    opts = opts || {};
    close();
    modal = document.createElement('div');
    modal.className = 'ac-backdrop';
    modal.innerHTML =
      '<div class="ac-modal" role="dialog" aria-modal="true" aria-labelledby="acTitle">' +
        '<div class="ac-head"><img src="../icons/icon48.png" alt=""><div><h2 id="acTitle"></h2>' +
        '<p class="muted">to continue to Eegai G Meet</p></div>' +
        '<button class="icon-btn ac-close" aria-label="Close">✕</button></div>' +
        '<div class="ac-body"><p class="muted ac-loading">Loading your Google accounts…</p></div>' +
        '<div class="ac-status hidden"></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('#acTitle').textContent = opts.title || 'Choose a Google account';
    modal.querySelector('.ac-close').addEventListener('click', () => { close(); opts.onDone && opts.onDone(null); });
    modal.addEventListener('click', e => { if (e.target === modal) { close(); opts.onDone && opts.onDone(null); } });

    const res = await EG.send({ type: 'accounts' });
    if (!modal) return;
    render(res.ok ? res : { google: null, saved: [], active: '' }, opts);
  };

  function render(data, opts) {
    const body = modal.querySelector('.ac-body');
    const saved = data.saved || [];
    const savedSet = new Set(saved.map(a => a.email));
    let html = '<ul class="ac-list">';

    if (data.google) {
      data.google.forEach(g => {
        const current = g.email === data.active;
        html += '<li><button class="ac-item" data-act="connect" data-index="' + g.index + '" data-email="' + esc(g.email) + '">' +
          avatar(g) + '<span class="ac-text"><b>' + esc(g.name) + '</b><small>' + esc(g.email) + '</small></span>' +
          (current ? '<span class="ac-badge">Current</span>' : savedSet.has(g.email) ? '<span class="ac-badge ghost">Connected</span>' : '') +
          '</button></li>';
      });
      // accounts connected before but no longer signed in to Google in this browser
      saved.filter(a => !data.google.some(g => g.email === a.email)).forEach(a => {
        html += '<li class="ac-row"><button class="ac-item" data-act="add">' +
          avatar(a) + '<span class="ac-text"><b>' + esc(a.name || a.email) + '</b><small>' + esc(a.email) + ' · signed out of Google</small></span></button>' +
          '<button class="ac-remove" data-act="forget" data-email="' + esc(a.email) + '" title="Remove from this list">Remove</button></li>';
      });
    } else {
      html += '<li><button class="ac-item" data-act="default">' +
        '<span class="ac-avatar ac-letter">G</span><span class="ac-text"><b>Continue with this browser\'s Google account</b>' +
        '<small>Your default Google account will be used</small></span></button></li>';
    }

    html += '<li><button class="ac-item" data-act="add"><span class="ac-avatar ac-add">+</span>' +
      '<span class="ac-text"><b>Use another account</b><small>Sign in to a new Gmail account</small></span></button></li>';
    html += '</ul>';
    if (data.active) {
      html += '<div class="ac-foot"><span class="muted">Signed in as <b>' + esc(data.active) + '</b></span>' +
        '<button class="btn red sm" data-act="signout">Sign out</button></div>';
    }
    html += '<p class="ac-note muted">Eegai never sees your password. Google asks you to <b>Allow</b> once per account, and each account saves to its own attendance Sheet.</p>';
    body.innerHTML = html;

    body.addEventListener('click', async e => {
      const btn = e.target.closest('[data-act]');
      if (!btn || modal.classList.contains('busy')) return;
      const act = btn.dataset.act;

      if (act === 'forget') {
        await EG.send({ type: 'forgetAccount', email: btn.dataset.email });
        return EG.openAccountChooser(opts);
      }
      if (act === 'signout') {
        await EG.send({ type: 'signOut' });
        EG.toast('Signed out — choose an account to continue');
        return EG.openAccountChooser(Object.assign({}, opts, { title: 'Choose a Google account' }));
      }
      if (act === 'connect' && btn.dataset.email === data.active) { close(); return opts.onDone && opts.onDone(null); }

      const msg = act === 'connect' ? { type: 'connectIndex', index: +btn.dataset.index }
        : act === 'add' ? { type: 'addAccount' } : { type: 'signIn' };
      setBusy(act === 'add'
        ? 'Sign in to your Gmail account in the Google window, then click Allow.'
        : 'If a Google window opens, click Allow to finish.');
      const r = await EG.send(msg);
      if (!modal) return;
      if (!r.ok) return setBusy(null, r.error);
      close();
      EG.toast('Signed in as ' + r.profile.email);
      opts.onDone && opts.onDone(r.profile);
    });
  }

  function setBusy(text, error) {
    const st = modal.querySelector('.ac-status');
    modal.classList.toggle('busy', !!text);
    st.classList.toggle('hidden', !text && !error);
    st.classList.toggle('error', !!error);
    st.textContent = error ? 'Could not sign in: ' + error : text || '';
  }
})();
