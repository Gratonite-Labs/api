# Gratonite API

[![Project](https://img.shields.io/badge/project-Gratonite-6d28d9)](https://github.com/CoodayeA/Gratonite)
[![Status](https://img.shields.io/badge/status-active-16a34a)](https://github.com/Gratonite-Labs/api)
[![Docs](https://img.shields.io/badge/source%20of%20truth-main%20repo-2563eb)](https://github.com/CoodayeA/Gratonite)

Backend API for Gratonite — a privacy-first, open-source alternative to Discord.

## What This Covers

- **109 database schemas** with Drizzle ORM + PostgreSQL
- **91 API route modules** on Express + TypeScript
- Real-time messaging via Socket.IO
- Voice/video via LiveKit integration
- End-to-end encryption key exchange (ECDH P-256 + AES-GCM-256)
- Instance federation with Ed25519 HTTP Signatures
- Guild management, roles, permissions, channels, threads
- DMs, group DMs, friend system, blocking
- Moderation: automod, word filters, timeouts, temp bans, ban appeals, raid protection
- Gamification: XP, leveling, FAME system, achievements, leaderboards
- Economy: virtual currency, cosmetics shop, marketplace, auctions
- OAuth2 authorization flow, webhooks, bot framework, slash commands
- Stripe payments, referrals
- GDPR data export, account deletion
- Scheduled messages, drafts, bookmarks, global search
- Web push notifications, email notifications

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22, TypeScript |
| Framework | Express 5 |
| Database | PostgreSQL 16, Drizzle ORM |
| Cache | Redis 7 |
| Realtime | Socket.IO |
| Voice | LiveKit |
| Auth | JWT (access + refresh), Argon2id password hashing, TOTP MFA |
| Security | Helmet.js, Zod validation, rate limiting, CORS, HTTP Signatures |
| Metrics | Prometheus |
| Email | Nodemailer |

## Docker Image

```bash
docker pull ghcr.io/coodayea/gratonite-api:latest
```

## Canonical Source of Truth

All source code lives in the main monorepo:

- [CoodayeA/Gratonite](https://github.com/CoodayeA/Gratonite) — path: `apps/api/`

If anything in this repo conflicts with the main repo, the main repo is authoritative.

## Related Repositories

- [Gratonite-Labs/web](https://github.com/Gratonite-Labs/web) — Web client
- [Gratonite-Labs/mobile](https://github.com/Gratonite-Labs/mobile) — Mobile client
- [Gratonite-Labs/desktop](https://github.com/Gratonite-Labs/desktop) — Desktop client
- [Gratonite-Labs/self-hosted](https://github.com/Gratonite-Labs/self-hosted) — Self-hosting guide
