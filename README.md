# ToonTalk Studio

Write a script, and cartoon / stick-figure characters act it out as vertical 9:16 videos with voices, subtitles and MP4 export.

## Run on your computer (full features)
```
npm install
copy .env.example .env      (then add your keys)
npm start                   (opens on http://localhost:3000)
```
Keys in `.env`: `SUNBIRD_API_KEY` (Luganda/English voices), `ANTHROPIC_API_KEY` (AI script helper). Never commit `.env`.

## Install on a phone (PWA)
Open the hosted page in Chrome and tap **Install app** (or menu -> Add to Home screen). After the first visit it opens offline.

- **Works offline:** writing scripts, playback with characters, props, action editor, projects (saved on the phone).
- **Needs the server:** Sunbird voices, MP4 export and the AI script helper.

## GitHub Pages
Push to `main`; the workflow in `.github/workflows/pages.yml` publishes `public/`. Enable it once under Settings -> Pages -> Source: GitHub Actions.
When you change `public/index.html`, bump `VERSION` in `public/sw.js` so installed phones pick up the update.
