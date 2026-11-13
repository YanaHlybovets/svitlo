# Security

## Reporting a vulnerability

Please don't open a public issue. Email **analytics@yanasworks.com** with details instead, and I'll reply as soon as I can.

## Rules for this repository

- No secrets in git: no Telegram bot token, master key, sensor keys, Wi-Fi passwords or Cloudflare API tokens.
  - Worker secrets live in `wrangler secret` (production) and `worker/.dev.vars` (local, git-ignored).
  - Firmware secrets live in `firmware/**/secrets.h` (git-ignored). Copy `secrets.example.h` to make your own.
- GitHub secret scanning and push protection are enabled.
- Never commit which apartments host sensors.
