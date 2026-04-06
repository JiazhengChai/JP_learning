# LangLens

![Static Badge](https://img.shields.io/badge/stack-HTML%20%2F%20CSS%20%2F%20Vanilla%20JS-0d1117?style=for-the-badge)
![Static Badge](https://img.shields.io/badge/storage-IndexedDB-0d1117?style=for-the-badge)
![Static Badge](https://img.shields.io/badge/runtime-browser%20only-0d1117?style=for-the-badge)

LangLens is a focused language study workspace for learning from real text. Import material, capture study items with a simple text-plus-note flow, and review them later with a lightweight spaced-repetition flashcard loop that stays entirely in your browser.

## Highlights

- Read from a personal library of imported texts.
- Save study items with just an input text and note.
- Group items into categories and keep metadata like added time and character count.
- Review due items with a front/back flashcard workflow.
- Export and import everything as JSON for easy backups.
- Create encrypted backups and restore them later with a passphrase.
- Request persistent browser storage and optionally save rolling backups to a folder.
- Get a dashboard reminder when your local-first library has no recent backup.
- Configure how quickly backup reminders appear and trigger a one-click backup from the dashboard.
- Keep all data local with no backend or account required.

## Screens

- Dashboard: at-a-glance stats, recent activity, and due review count.
- Library: organize sources and open them in the reader.
- Items: browse saved items by category, source, mastery, and review state.
- Review: study prompt-only cards, flip for the note, then rate recall.

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
- folder backups are useful if you point them at a synced folder such as OneDrive.

## Backup And Restore

- Use Backup to download a plain JSON snapshot or an encrypted backup file.
- Use Restore to inspect a backup before applying it.
- Replace restore is best for full recovery on a new browser.
- Merge restore is best for combining two libraries without wiping the current one.
- On Chromium-based browsers, you can also save backups directly into a folder, keep that folder selected across sessions, and enable session auto-save.
- The backup center lets you choose the reminder threshold in days.
- After upgrading older local databases, the dashboard shows a short migration notice pointing users to the new backup tools.

## Project Structure

- `index.html` - app shell and navigation
- `styles.css` - visual design and layout
- `js/db.js` - IndexedDB data layer
- `js/app.js` - UI, navigation, and review logic

## Notes

- The app is currently set up as a single-page static site.
- The UI is optimized for reading, selection, and review rather than content creation.
