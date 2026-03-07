# Gratonite API

Backend API for Gratonite.

This repo represents the backend slice of the Gratonite project: authentication, guilds, channels, messages, threads, voice, moderation, events, and realtime infrastructure.

## Canonical Source Of Truth

The most current documentation and project context live in the main repo:

- [CoodayeA/Gratonite](https://github.com/CoodayeA/Gratonite)
- Canonical backend path: `apps/api`

If anything in this repo conflicts with the main `Gratonite` repo, treat the main repo as authoritative.

## What This Backend Covers

- Express + TypeScript API
- PostgreSQL + Drizzle ORM
- Redis-backed realtime and stateful features
- Socket.IO for live messaging and presence
- LiveKit integration for voice features
- Guild, DM, thread, moderation, and event routes

## Related Repositories

- [Gratonite-Labs/web](https://github.com/Gratonite-Labs/web)
- [Gratonite-Labs/mobile](https://github.com/Gratonite-Labs/mobile)
- [Gratonite-Labs/desktop](https://github.com/Gratonite-Labs/desktop)
- [Gratonite-Labs/self-hosted](https://github.com/Gratonite-Labs/self-hosted)

## Notes

This README is intentionally high level so it stays accurate. For setup, deployment, and current architecture details, use the main repo.
