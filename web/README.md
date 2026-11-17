# web/

The public website, served as static files by the `svitlo` Worker ([ADR 0004](../docs/decisions/0004-worker-static-assets.md)). Live at https://svitlo.yanasworks.com.

Plain HTML, CSS and JavaScript modules: no framework, no build step, no cookies, trackers or third-party scripts.

| Path | |
|---|---|
| `index.html` + `assets/home.js` | Search (Ukrainian, Russian or Latin spelling), starred "my addresses", buildings by district with live status badges |
| `b.html` + `assets/building.js` | Building page at `/b/<slug>` (rewrite in `_redirects`): big status, "since", when the sensor last reported, Telegram alerts button, 24-hour timeline, 7 days with hours without power |
| `assets/common.js` | Texts (Ukrainian first, English switch), Kyiv time, search, starred addresses, polling |
| `assets/app.css` | Light and dark themes; status shown by colour **and** icon and text |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable app (PWA); last data stays viewable offline |
| `_headers` | Strict CSP (`'self'` only), HSTS, no framing |
| `.assetsignore` | Keeps non-site files out of the upload |

Pages poll the API every 60 s, only while the tab is visible. "My addresses" and the language are kept only in this browser (`localStorage`).

Run it locally with the Worker: `cd ../worker && npm run dev`, then open http://localhost:8787.
