# web/

Static website, served as static assets by the `svitlo` Worker (Phase 5; see ADR 0004): building list with live status badges, building pages with a 24 h timeline and 7-day history, and a Telegram deep link per address. PWA, Ukrainian first. No cookies, trackers or third-party scripts.

Live at https://svitlo.yanasworks.com (a placeholder page for now). Security headers are in `_headers`; `.assetsignore` keeps non-site files out of the upload.
