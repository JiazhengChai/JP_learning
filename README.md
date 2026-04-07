# LangLens

![Static Badge](https://img.shields.io/badge/stack-HTML%20%2F%20CSS%20%2F%20Vanilla%20JS-0d1117?style=for-the-badge)
![Static Badge](https://img.shields.io/badge/storage-IndexedDB-0d1117?style=for-the-badge)
![Static Badge](https://img.shields.io/badge/runtime-browser%20only-0d1117?style=for-the-badge)

LangLens is a focused language study workspace for learning from real text. Import material, capture study items with a simple text-plus-note flow, and review them later with a lightweight spaced-repetition flashcard loop that stays entirely in your browser.

## Highlights

- Read from a personal library of imported texts.
- Drop files or plain text onto the dashboard or library to create texts quickly.
- Save study items with just an input text and note.
- Import a line-based item list from a text file using formats like `word:note` or `word`.
- Capture reading notes in context and browse them later by source or color.
- Group items into categories and keep metadata like added time and character count.
- Review due items with a front/back flashcard workflow and filter by multiple categories, source texts, and mastery levels.
- Save encrypted JSON in one click from the always-visible quick backup control, or open Backup for more options.
- Export and import everything as JSON for easy backups.
- Create encrypted backups and restore them later with a passphrase.
- Request persistent browser storage and save backups into a chosen folder, or pick one when the browser supports it.
- Point that folder at a desktop-synced location such as Google Drive Desktop, OneDrive, or Dropbox for automatic cloud sync.
- Get a dashboard reminder when your local-first library has no recent backup.
- Configure how quickly backup reminders appear and trigger a one-click backup from the dashboard.
- Keep all data local with no backend or account required.

## Screens

- Dashboard: at-a-glance stats, recent activity, due review count, and quick drag-and-drop text import.
- Library: organize sources and open them in the reader.
- Items: browse saved items by category, source, mastery, and review state, or bulk import them from a line-based text file.
- Notes: browse saved reading notes by source, color, and creation date.
- Review: study prompt-only cards, flip for the note, filter the queue, then rate recall.

## Tech Stack

- HTML, CSS, and vanilla JavaScript
- IndexedDB for persistent storage
- Google Fonts for typography

## Why It Feels Good To Use

LangLens is designed around the reading loop rather than generic note-taking. The sidebar keeps navigation simple, adding an item is intentionally lightweight, and the review system makes the stored notes useful after the first pass.

## Run Locally

1. Open `index.html` in a browser, or serve the folder with a local static server.
2. Start importing text and saving highlights.
3. Use Export to back up your data, and Import to restore it later.

If you prefer a local server, any static file server works. For example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Run Tests

```bash
npm install
npm test
```

## Preview

If you add screenshots later, this is a good place to show the dashboard, reader, and review flow. A single full-width screenshot or a short 2-3 image strip will work well here.

## Data Storage

All app data is stored in the browser using IndexedDB. That means:

- data stays on the current device and browser profile,
- clearing site data removes everything,
- persistent storage can reduce eviction risk on supported browsers,
- exporting JSON is the safest way to back up your library,
- encrypted backups can be restored on another browser or device,
- encrypted backup files are stored as sealed ciphertext, so the saved file does not expose your library contents without the passphrase,
- folder backups are useful if you point them at a synced folder such as Google Drive Desktop, OneDrive, or Dropbox.

## Backup And Restore

- The always-visible quick backup control saves encrypted JSON in one click.
- Use Backup to save an encrypted backup file by default, adjust passphrases, or switch to plain JSON after the warning confirmation.
- On browsers with file system access, manual backups write to the remembered folder or ask you to choose one before saving.
- On browsers without a save or folder picker, LangLens falls back to the browser's normal download flow.
- Encrypted backups keep the saved file unreadable without the passphrase.
- Use Restore to inspect a backup before applying it.
- Replace restore is best for full recovery on a new browser.
- Merge restore is best for combining two libraries without wiping the current one.
- On Chromium-based browsers, you can also save backups directly into a folder, keep that folder selected across sessions, and let LangLens auto-update one rolling encrypted latest-backup file after changes.
- That folder can be a cloud-synced desktop folder, which gives you automatic off-device backup without adding a backend.
- If a sync folder is configured, Restore can pull the rolling latest encrypted backup or the newest timestamped snapshot directly from that folder.
- The backup center lets you choose the reminder threshold in days.
- After upgrading older local databases, the dashboard shows a short migration notice pointing users to the new backup tools.

## Project Structure

- `index.html` - app shell and navigation
- `styles.css` - visual design and layout
- `js/db.js` - IndexedDB data layer
- `js/item-import-utils.js` - line-based item list parsing and deduping helpers
- `js/app.js` - UI, navigation, and review logic

## Notes

- The app is currently set up as a single-page static site.
- The UI is optimized for reading, selection, and review rather than content creation.
