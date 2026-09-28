# Eegai G Meet Auto admin & attendance tracker

A free Chrome extension for Google Meet with two main jobs:

- **Auto Admit.** Lets in people who ask to join, so you don't have to click Admit for each one.
- **Attendance tracking.** Records each participant's join time, leave time and total time in the call. At the end it builds a report, downloads a CSV, and adds the rows to one Google Sheet.

## Features

| Feature | Details |
|---|---|
| Google sign-in (required) | Users sign in with their Gmail account. On first install the dashboard opens with a **Sign in with Google** screen, and tracking stays off until they sign in. |
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
4. Copy the **extension ID** that Chrome shows. You need it for the Google sign-in setup below.

## One-time Google sign-in setup (OAuth client ID)

Signing in and saving to Google Sheets both use Google's OAuth. Google needs a client ID that belongs to you:

1. Go to <https://console.cloud.google.com/> and create a project, for example "Eegai Meet".
2. Under **APIs & Services → Library**, enable the **Google Sheets API**.
3. Under **APIs & Services → OAuth consent screen**:
   - Choose **External**.
   - Fill in the app name and support email.
   - Add these scopes: `userinfo.email`, `userinfo.profile` and `.../auth/drive.file`.
   - While testing, add your Gmail address as a test user.
4. Under **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Choose the application type **Chrome Extension**.
   - Paste your extension ID.
5. Copy the client ID into `manifest.json`, replacing `YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com`.
6. Reload the extension in `chrome://extensions`.

Keeping the same extension ID:

- An unpacked extension's ID can change if it is loaded from a different folder. To keep it fixed while developing, add a `"key"` to `manifest.json` (see Chrome's docs).
- After you publish to the Chrome Web Store, create the OAuth client with the **store** extension ID.

The `drive.file` scope only lets the extension see the spreadsheet it creates. It cannot read any of your other Drive files.

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
- **Browsers.** Sign-in uses `chrome.identity.getAuthToken`, which works in Google Chrome. It does not work in Edge, Brave or other Chromium browsers.

## Files

```
manifest.json          MV3 manifest (permissions: storage, identity, alarms)
background.js          Sign-in, Google Sheets, turning sessions into reports, report window, retries
content/meet.js        Runs on meet.google.com: attendance tracking, Auto Admit, floating panel
lib/common.js          Shared helpers: CSV, formatting, building reports
lib/ui.css             Shared styles
popup/                 Toolbar popup (sign-in, Auto Admit toggle, shortcuts)
dashboard/             My Reports, Participant Lists, Settings, Help Desk
report/                End-of-meeting report window (CSV download, save to Sheet)
sample/participants_sample.csv
PRIVACY.md             Privacy policy (needed for the Chrome Web Store)
```
