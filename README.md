# Gratonite — API

The backend for Gratonite. A Node.js + Express 5 REST/tRPC server written in TypeScript, handling authentication, real-time messaging (Socket.io), voice/video rooms (LiveKit), file storage (MinIO), and a virtual economy.

## Table of Contents

- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Modules](#modules)
- [Available Scripts](#available-scripts)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 20 |
| Language | TypeScript 5.7 |
| Framework | Express 5.0 |
| API Layer | tRPC 11 + REST |
| ORM | Drizzle ORM 0.45 |
| Database | PostgreSQL 16 |
| Cache / Pub-Sub | Redis 7 (ioredis) |
| Real-time | Socket.io 4 |
| Voice / Video | LiveKit Server SDK |
| File Storage | MinIO (S3-compatible) |
| Auth | JWT (jose) + MFA (otplib) + Argon2 |
| Email | Nodemailer |
| Image Processing | Sharp |
| Logging | Pino + pino-pretty |
| Validation | Zod |
| Testing | Vitest |

---

## Prerequisites

Make sure the following are installed and running before you start:

- **Node.js** ≥ 20 — [nodejs.org](https://nodejs.org)
- **pnpm** ≥ 10 — `npm install -g pnpm`
- **PostgreSQL 16** on port `5433`
- **Redis 7** on port `6379`
- **MinIO** on ports `9000` (API) / `9001` (console)
- **LiveKit** on port `7880`

The easiest way to run the infrastructure is with Docker Compose from the monorepo root.

---

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/Gratonite-Labs/api.git
cd api
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Set up environment variables

```bash
cp .env.example .env
```

Then edit `.env` with your values — see the [Environment Variables](#environment-variables) section below.

### 4. Run database migrations

```bash
pnpm --filter @gratonite/db migrate
```

Or from this directory if you have the `db` package available:

```bash
cd ../packages/db && pnpm migrate
```

### 5. Start the development server

```bash
pnpm dev
```

The API will be available at `http://localhost:4000`.

---

## Environment Variables

Create a `.env` file in the project root. All required variables are listed below.

### Database

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5433/gratonite` |

### Redis

| Variable | Description | Example |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |

### Auth / Security

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | Secret used to sign JWT access tokens | any long random string |
| `JWT_REFRESH_SECRET` | Secret used to sign JWT refresh tokens | a different long random string |
| `COOKIE_SECRET` | Secret for signed cookies | any long random string |

### File Storage (MinIO)

| Variable | Description | Example |
|----------|-------------|---------|
| `MINIO_ENDPOINT` | MinIO host | `localhost` |
| `MINIO_PORT` | MinIO port | `9000` |
| `MINIO_ACCESS_KEY` | MinIO access key | `minioadmin` |
| `MINIO_SECRET_KEY` | MinIO secret key | `minioadmin` |
| `MINIO_BUCKET` | Default bucket name | `gratonite` |

### LiveKit (Voice / Video)

| Variable | Description | Example |
|----------|-------------|---------|
| `LIVEKIT_HOST` | LiveKit server URL | `ws://localhost:7880` |
| `LIVEKIT_API_KEY` | LiveKit API key | `devkey` |
| `LIVEKIT_API_SECRET` | LiveKit API secret | `devsecret` |

### Email (Nodemailer)

| Variable | Description | Example |
|----------|-------------|---------|
| `SMTP_HOST` | SMTP server hostname | `smtp.mailgun.org` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | `postmaster@yourdomain.com` |
| `SMTP_PASS` | SMTP password | `...` |
| `SMTP_FROM` | Sender address | `Gratonite <noreply@gratonite.com>` |

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port the server listens on | `4000` |
| `NODE_ENV` | Environment (`development` / `production`) | `development` |
| `CORS_ORIGINS` | Comma-separated list of allowed origins | `http://localhost:5174` |

---

## Project Structure

```
src/
├── index.ts              # Entry point — bootstraps Express + Socket.io
├── env.ts                # Zod-validated environment config
├── middleware/
│   ├── auth.ts           # JWT verification middleware
│   ├── bot-auth.ts       # Bot token verification
│   ├── daily-login.ts    # Daily login streak tracking
│   ├── rate-limiter.ts   # Redis-backed rate limiting
│   └── security-headers.ts  # Helmet + custom headers
├── lib/
│   ├── context.ts        # tRPC context builder
│   ├── cors-origins.ts   # Dynamic CORS origin resolver
│   ├── gateway-intents.ts  # Socket.io event declarations
│   ├── latency-alerts.ts # Slow-request alerting
│   ├── logger.ts         # Pino logger instance
│   ├── mailer.ts         # Nodemailer transporter
│   ├── minio.ts          # MinIO client
│   ├── redis.ts          # ioredis client
│   ├── request-metrics.ts  # Per-route latency tracking
│   └── snowflake.ts      # Snowflake ID generator
└── modules/              # Feature modules (router + service + schemas)
    ├── auth/             # Register, login, MFA, OAuth, refresh tokens
    ├── bots/             # Bot accounts and bot token management
    ├── channels/         # Text channels inside servers
    ├── community-shop/   # Virtual item store
    ├── dms/              # Direct messages
    ├── economy/          # Virtual currency and transactions
    ├── emojis/           # Custom server emojis
    ├── friends/          # Friend requests and relationships
    ├── messages/         # Message CRUD + link preview generation
    ├── notifications/    # Push and in-app notifications
    ├── profile/          # User profile and settings
    ├── reactions/        # Message reactions
    ├── roles/            # Server roles and permissions
    ├── servers/          # Community servers
    ├── uploads/          # File and image upload handling
    ├── users/            # User management
    └── voice/            # LiveKit room management
```

Each module follows the same pattern:

```
modules/<name>/
├── <name>.router.ts    # Express/tRPC route definitions
├── <name>.service.ts   # Business logic
└── <name>.schemas.ts   # Zod input/output schemas
```

---

## Modules

### Auth
Handles registration, login, logout, JWT access/refresh token rotation, MFA setup (TOTP via `otplib`), QR code generation, and OAuth flows. Passwords are hashed with Argon2.

### Messages
Full CRUD for messages, including link-preview generation via `open-graph-scraper` and per-channel cursor-based pagination.

### Voice
Creates and manages LiveKit rooms for voice/video channels. Issues participant tokens scoped to a room.

### Economy
Virtual currency system — earn, spend, transfer, and view transaction history.

### Uploads
Multipart file uploads via `multer`, resized/converted with `sharp`, and stored in MinIO.

### Community Shop
Virtual item listings, purchases, and inventory management.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start the server with hot-reload (`tsx watch`) |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run the compiled build (`node dist/index.js`) |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run tests once with Vitest |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:ci` | Run tests in CI mode (pass with no tests) |
| `pnpm clean` | Delete `dist/` |

---

## Testing

Tests live alongside the source files as `*.test.ts` files and are run with Vitest.

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Run a specific file
pnpm vitest run src/lib/cors-origins.test.ts
```

Current test coverage includes:
- `src/lib/cors-origins.test.ts` — CORS origin allowlist logic
- `src/lib/latency-alerts.test.ts` — slow-request alert thresholds
- `src/modules/economy/economy.service.test.ts` — economy transaction logic
- `src/modules/economy/economy.schemas.test.ts` — Zod schema validation
- `src/modules/community-shop/community-shop.service.test.ts`
- `src/modules/community-shop/community-shop.schemas.test.ts`

---

## Deployment

### Docker

A `Dockerfile` should exist at the project root. Build and run:

```bash
# Build
docker build -t gratonite-api .

# Run
docker run -p 4000:4000 \
  -e DATABASE_URL=postgresql://... \
  -e REDIS_URL=redis://... \
  -e JWT_SECRET=... \
  gratonite-api
```

### Environment

Set `NODE_ENV=production` in production. The Pino logger will switch to JSON output and pino-pretty will be disabled.

```bash
NODE_ENV=production pnpm start
```

---

## Troubleshooting

### `Cannot connect to PostgreSQL`
- Confirm PostgreSQL is running on port `5433` (not the default `5432`)
- Check `DATABASE_URL` in your `.env`
- Try: `psql postgresql://postgres:postgres@localhost:5433/gratonite`

### `Redis connection refused`
- Confirm Redis is running: `redis-cli ping` → should return `PONG`
- Check `REDIS_URL` in your `.env`

### `MinIO bucket not found`
- Open the MinIO console at `http://localhost:9001`
- Log in with your `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`
- Create a bucket named `gratonite` (or whatever `MINIO_BUCKET` is set to)

### `LiveKit token error`
- Confirm LiveKit is running: `curl http://localhost:7880`
- Double-check `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` match the LiveKit config

### Migrations fail
```bash
# From the packages/db directory
pnpm generate   # re-generate migration files from schema
pnpm migrate    # apply pending migrations
```
