# LangLens

![Static Badge](https://img.shields.io/badge/stack-HTML%20%2F%20CSS%20%2F%20Vanilla%20JS-0d1117?style=for-the-badge)
![Static Badge](https://img.shields.io/badge/storage-IndexedDB-0d1117?style=for-the-badge)
![Static Badge](https://img.shields.io/badge/runtime-browser%20only-0d1117?style=for-the-badge)

LangLens is a focused language study workspace for learning from real text. Import material, capture vocabulary and grammar in context, and review it later with a lightweight spaced-repetition flow that stays entirely in your browser.

## Highlights

- Read from a personal library of imported texts.
- Save vocabulary, grammar notes, and phrases while you study.
- Review due items with a compact flashcard-style workflow.
- Export and import everything as JSON for easy backups.
- Keep all data local with no backend or account required.

## Screens

- Dashboard: at-a-glance stats, recent activity, and due review count.
- Library: organize sources and open them in the reader.
- Vocabulary: browse saved items by type, mastery, and review state.
- Review: study due cards and rate how well you know them.

## Tech Stack

- HTML, CSS, and vanilla JavaScript
- IndexedDB for persistent storage
- Google Fonts for typography

## Why It Feels Good To Use

LangLens is designed around the reading loop rather than generic note-taking. The sidebar keeps navigation simple, the reader is built for fast selection and tagging, and the review system makes the stored items useful after the first pass.

## Run Locally

1. Open `index.html` in a browser, or serve the folder with a local static server.
2. Start importing text and saving highlights.
3. Use Export to back up your data, and Import to restore it later.

If you prefer a local server, any static file server works. For example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Preview

If you add screenshots later, this is a good place to show the dashboard, reader, and review flow. A single full-width screenshot or a short 2-3 image strip will work well here.

## Data Storage

All app data is stored in the browser using IndexedDB. That means:

- data stays on the current device and browser profile,
- clearing site data removes everything,
- exporting JSON is the safest way to back up your library.

## Project Structure

- `index.html` - app shell and navigation
- `styles.css` - visual design and layout
- `js/db.js` - IndexedDB data layer
- `js/app.js` - UI, navigation, and review logic

## Notes

- The app is currently set up as a single-page static site.
- The UI is optimized for reading, selection, and review rather than content creation.
