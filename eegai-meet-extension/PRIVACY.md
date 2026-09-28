# Privacy Policy — Eegai G Meet Auto admin & attendance tracker

_Last updated: 28 September 2026_

This extension is free and has no servers of its own. It does not sell, share or send your data to its developers.

## What the extension handles

| Data | Where it is kept | Why |
|---|---|---|
| Your Google email address | In your browser (`chrome.storage.local`) | To show who is signed in and to fill in your own email in reports |
| Names of meeting participants, with their join and leave times | In your browser, and in a Google Sheet in **your** Google Drive | To produce attendance reports |
| Participant lists (names and mail IDs) that you enter or upload | In your browser | To match emails to names and mark absentees |
| Settings | In Chrome sync storage | To keep your preferences |

## Google permissions

Saving to Google Sheets goes through the extension's Google Apps Script connector. The connector runs under **your** Google account and asks for only two permissions:

- `userinfo.email`, to identify the account you signed in with.
- `drive.file`, to create and write **only** the attendance spreadsheet it makes. It cannot see your other Drive files.

The extension never sees or stores your Google password or tokens. It talks only to Google's own services (`script.google.com` and `script.googleusercontent.com`), and it reads only `meet.google.com` pages.

## Your control

- **Sign out.** Signing out forgets your account in the extension. To remove the connector's access completely, go to <https://myaccount.google.com/permissions>.
- **Delete reports.** You can delete reports from **My Reports**.
- **Remove everything.** Uninstalling the extension removes all data stored in your browser. Your Google Sheet stays in your Drive until you delete it.
