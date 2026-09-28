/**
 * Eegai G Meet Auto admin & attendance tracker — Google Sheet connector.
 *
 * Deploy once at https://script.google.com as a Web app:
 *   Execute as: "User accessing the web app"   Who has access: "Anyone with a Google account"
 * Each user who connects gets their OWN "Eegai G Meet Attendance" sheet in their OWN Drive.
 * Scopes are drive.file (only files this script creates) + email, so no Google Cloud Console setup is needed.
 */
var SHEET_TITLE = 'Eegai G Meet Attendance';
var TAB = 'Attendance';
var HEADERS = ['Meeting Name', 'Meeting ID', 'Date', 'Participant', 'Email', 'In Time', 'Out Time', 'Duration', 'Attendance'];

function doGet(e) {
  var info, error = '';
  try { info = ensureSheet_(false); } catch (err) { error = String(err && err.message || err); }
  var t = HtmlService.createTemplate(CONNECT_PAGE_);
  t.info = info || {};
  t.error = error;
  return t.evaluate()
    .setTitle('Eegai G Meet — Connected')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { /* empty */ }
  try {
    var out;
    if (req.action === 'ping') out = ensureSheet_(false);
    else if (req.action === 'newSheet') out = ensureSheet_(true);
    else if (req.action === 'append') out = append_(req.rows, req.expectEmail);
    else throw new Error('Unknown action');
    out.ok = true;
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function email_() {
  return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '';
}

function ensureSheet_(forceNew) {
  var lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    var props = PropertiesService.getUserProperties();
    var id = forceNew ? '' : props.getProperty('sheetId');
    if (id) {
      try { Sheets.Spreadsheets.get(id, { fields: 'spreadsheetId' }); } catch (err) { id = ''; }
    }
    if (!id) {
      id = createSheet_();
      props.setProperty('sheetId', id);
    }
    return { email: email_(), sheetId: id, sheetUrl: 'https://docs.google.com/spreadsheets/d/' + id + '/edit' };
  } finally {
    lock.releaseLock();
  }
}

function createSheet_() {
  var ss = Sheets.Spreadsheets.create({
    properties: { title: SHEET_TITLE },
    sheets: [{ properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } }]
  });
  var id = ss.spreadsheetId;
  var tabId = ss.sheets[0].properties.sheetId;
  Sheets.Spreadsheets.Values.update({ values: [HEADERS] }, id, TAB + '!A1:I1', { valueInputOption: 'RAW' });
  try {
    Sheets.Spreadsheets.batchUpdate({
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
    }, id);
  } catch (err) { /* formatting is cosmetic */ }
  return id;
}

function append_(rows, expectEmail) {
  var info = ensureSheet_(false);
  if (expectEmail && info.email && String(expectEmail).toLowerCase() !== info.email.toLowerCase()) {
    throw new Error('Your browser is signed in to Google as ' + info.email + ', not ' + expectEmail + '. Switch account or sign in again in the extension.');
  }
  if (!rows || !rows.length) return info;
  var clean = rows.slice(0, 5000).map(function (r) {
    return HEADERS.map(function (_, i) { return r[i] == null ? '' : String(r[i]).slice(0, 500); });
  });
  Sheets.Spreadsheets.Values.append({ values: clean }, info.sheetId, TAB + '!A:I', {
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS'
  });
  return info;
}

var CONNECT_PAGE_ = [
  '<!doctype html><html><head><base target="_top"><style>',
  'body{font-family:Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f6f7f9;color:#1f2937}',
  '.box{max-width:440px;margin:48px auto;background:#fff;border-radius:14px;padding:28px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.08)}',
  '.ok{width:64px;height:64px;border-radius:16px;background:#1a8a4f;color:#fff;font-size:40px;line-height:64px;margin:0 auto 12px}',
  '.err{background:#dc3545}a.btn{display:inline-block;margin-top:16px;padding:10px 18px;border-radius:8px;background:#1a8a4f;color:#fff;text-decoration:none}',
  'p{color:#6b7280}</style></head><body><div class="box">',
  '<? if (error) { ?><div class="ok err">!</div><h2>Could not connect</h2><p><?= error ?></p>',
  '<? } else { ?><div class="ok">&#10003;</div><h2>Connected to Eegai G Meet</h2>',
  '<p>Signed in as <b><?= info.email ?></b>.<br>Attendance will be saved to your sheet <b>Eegai G Meet Attendance</b>.</p>',
  '<a class="btn" href="<?= info.sheetUrl ?>">Open my attendance sheet</a>',
  '<p style="margin-top:18px">This window will close by itself. You can also close it now.</p><? } ?>',
  '</div></body></html>'
].join('\n');
