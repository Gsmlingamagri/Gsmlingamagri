# Eegai G Meet Auto admin & attendance tracker

A free Chrome extension for Google Meet with two main jobs:

- **Auto Admit.** Lets in people who ask to join, so you don't have to click Admit for each one.
- **Attendance tracking.** Records each participant's join time, leave time and total time in the call. At the end it builds a report, downloads a CSV, and adds the rows to one Google Sheet.

## Features

| Feature | Details |
|---|---|
| Google sign-in (required), switch / add account, sign out | Users sign in with their Gmail account, which uses the Apps Script connector, so no Google Cloud Console setup is needed. On first install the dashboard opens with a **Sign in with Google** screen, and tracking stays off until they sign in. |
| Auto Admit button in Meet | A green **Eegai Meet** panel appears in every meeting. Click **Auto Admit** to turn it ON or OFF. When it's ON, "Admit" and "Admit all" requests are accepted automatically. Settings can limit this to **only people in your participant lists**. |
| Attendance tracking | Starts on its own when you join a call. For each person it logs first In time, last Out time, total duration (rejoins are added up) and the number of joins. |
| Report on meeting end | When you leave the call or close the tab, a popup window opens with the participant report and the CSV downloads automatically. |
| One Google Sheet for everything | Every meeting is added to the same sheet, **Eegai G Meet Attendance**, with these columns: `Meeting Name \| Meeting ID \| Date \| Participant \| Email \| In Time \| Out Time \| Duration \| Attendance` |
| Participant lists (Name \| Mail ID) | Create lists by hand or bulk-upload a CSV ([sample file](sample/participants_sample.csv)). Link a list to a **meeting link**, or mark one as the **default list**. Reports then fill in mail IDs and mark people who never joined as **Absent**. |
| My Reports dashboard | Search, paging, rename a meeting, share a summary, Sheet sync status, view, delete, bulk delete, export all as CSV, and a storage meter. |
| Offline-safe | If a report can't be saved to the Sheet, it is retried every 15 minutes, or on demand with **Sync pending to Sheet**. |

## Install (developer mode)

1. Download this folder (`eegai-meet-extension/`).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `eegai-meet-extension` folder.
4. Complete the one-time **Google Sheet connector** setup below.

## Google Sheet connector (one-time setup, no Google Cloud Console)

The extension saves to Google Sheets through a small **Google Apps Script** web app (`apps-script/`). You deploy it **once**, as the extension owner. Your users never have to do this.

1. Open <https://script.google.com> and click **New project**. Name it "Eegai G Meet Connector".
2. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Go to **Project Settings** (gear icon) and tick **Show "appsscript.json" manifest file in editor**. Then replace that file's contents with [`apps-script/appsscript.json`](apps-script/appsscript.json).
4. Click **Deploy → New deployment**, choose the type **Web app**, and set:
   - **Execute as:** *User accessing the web app*
   - **Who has access:** *Anyone with Google account*
5. Click **Deploy**. Approve access for your own account, then copy the **Web app URL** (it ends in `/exec`).
6. Paste the URL into [`config.js`](config.js) as `WEBAPP_URL: 'https://script.google.com/macros/s/.../exec'`, then reload the extension.
   You can instead paste it under **Settings → Google Sheet connector** in the extension.

How it works for your users:

- **Signing in:** they click **Sign in with Google**. A Google window opens where they pick their Gmail account and click **Allow** once.
- **Their own sheet:** each user gets their **own** "Eegai G Meet Attendance" sheet in **their own** Drive.
- **Minimal access:** the script only asks for `drive.file` (it can see only the sheet it creates) and your email address.
- **No verification:** both of those are non-sensitive scopes, so Google does not require app verification.

If you later change `Code.gs`, go to **Deploy → Manage deployments**, edit the deployment and choose **New version**. This keeps the same URL.

## How to use

1. Click the extension icon and choose **Sign in with Google**. Your attendance Sheet is created in your Drive.
2. *(Optional)* Go to **Participant Lists** and click **+ New list**:
   - Add names and mail IDs, or click **Upload CSV**.
   - Paste the meeting link and click **Save list**.
3. Join a Google Meet. The Eegai panel shows **Tracking attendance · N in call**.
4. Click **Auto Admit: OFF** to turn it **ON**. You must be the meeting host or a co-host.
5. When the meeting ends, the report window opens, the CSV downloads and the rows are added to the Sheet.

## Notes and limits

- **Emails.** Google Meet does not show participants' email addresses. Eegai fills in the email by matching each display name to your participant lists. For your own row it uses your signed-in email.
- **How detection works.** Google Meet has no public attendance API, so the extension reads the Meet page itself (the People panel and the video tiles). It opens the People panel once so that everyone is counted, not just the people whose tiles are on screen. For the most reliable results, use Meet in **English**.
- **Several Google accounts.** The account menu (top right of the dashboard, or in the toolbar popup) has these options:
  - **Switch account:** pick any Gmail account signed in to the browser.
  - **Add another account:** opens Google's own sign-in page to add a new Gmail account.
  - **Sign out:** signs out of Eegai, then shows the account picker so you can choose a different Gmail.

  Each account saves to its own attendance Sheet. A report is saved to the Sheet of the account that was active when the meeting was recorded.
- **Browsers.** It works in Chrome, Edge, Brave and other Chromium browsers.

## Files

```
manifest.json          MV3 manifest (permissions: storage, alarms)
config.js              Connector web app URL (set once)
apps-script/           Google Sheet connector (Code.gs + appsscript.json), deployed at script.google.com
background.js          Sign-in and Google Sheets (via the connector), turning sessions into reports, report window, retries
content/meet.js        Runs on meet.google.com: attendance tracking, Auto Admit, floating panel
lib/common.js          Shared helpers: CSV, formatting, building reports
lib/ui.css             Shared styles
popup/                 Toolbar popup (sign-in, Auto Admit toggle, shortcuts)
dashboard/             My Reports, Participant Lists, Settings, Help Desk
report/                End-of-meeting report window (CSV download, save to Sheet)
sample/participants_sample.csv
PRIVACY.md             Privacy policy (needed for the Chrome Web Store)
```
