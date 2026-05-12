# Aisle Backend

NestJS API server for the Aisle platform. Runs on **port 3002** in local dev, **port 3000** inside Docker.

---

## Prerequisites

| Requirement | Check |
|---|---|
| Node.js v18+ | `node --version` |
| Docker + Docker Compose | `docker --version` |
| At least one LLM API key | OpenRouter has a free tier |

---

## Local development — first-time setup

### 1. Copy the environment file

```bash
cp .env.example .env
```

### 2. Add your LLM API key

Open `.env` and fill in at least one provider. OpenRouter is the easiest free option:

```env
OPENROUTER_API_KEY=your-key-here
DEFAULT_LLM_PROVIDER=openrouter
```

All other values in `.env.example` are pre-configured and work as-is.

### 3. Install dependencies

```bash
npm install
```

### 4. Start

```bash
npm run start:dev
```

Everything else is **automatic on every start**:

| What | How |
|---|---|
| Docker infrastructure (Postgres, Redis, Qdrant, MinIO) | `scripts/start-infra.sh` via `prestart:dev` |
| Database schema | TypeORM migrations run automatically (`migrationsRun: true`) |
| MinIO bucket (`aisle-documents`) | Created by `StorageService.onModuleInit()` if missing |
| Subscription plans (Starter, Business, Enterprise) | Seeded by `PlansService.onModuleInit()` if table is empty |

The backend is ready when you see:

```
Application is running on: http://localhost:3002
```

---

## Running the full app

From the **repo root**:

```bash
./start.sh
```

| Service | URL |
|---|---|
| Backend API | http://localhost:3002 |
| Frontend | http://localhost:8927 |

---

## Production deployment

### How production differs from local dev

| | Local dev | Production |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| Schema management | `synchronize: true` (auto-sync entities) | `synchronize: false` (migrations only) |
| Port | 3002 (from `.env`) | 3000 (inside container, mapped by Docker) |
| Infrastructure | Local Docker containers | Managed services (RDS, ElastiCache, etc.) |

### What happens on a production deploy

The app is containerised via `Dockerfile`. On startup:

1. `node dist/main` runs the compiled NestJS app
2. TypeORM checks the `migrations` table and runs any pending migrations
3. `1700000000000-InitialSchema` — creates all tables on a fresh database. On an existing database (set up before this migration was committed) it detects the `tenants` table already exists and **skips silently** — no manual intervention needed.
4. The 4 incremental migrations run in timestamp order on top of the base schema.
5. MinIO bucket and subscription plans are initialised the same way as local dev.

### Required environment variables in production

At minimum, set these on your hosting platform / CI:

```env
NODE_ENV=production
PORT=3000

DATABASE_HOST=<your-rds-or-postgres-host>
DATABASE_PORT=5432
DATABASE_USERNAME=<user>
DATABASE_PASSWORD=<password>
DATABASE_NAME=<db>

REDIS_HOST=<your-redis-host>
REDIS_PORT=6379

QDRANT_URL=http://<your-qdrant-host>:6333
QDRANT_COLLECTION_NAME=documents

S3_ENDPOINT=<your-s3-or-minio-endpoint>
S3_ACCESS_KEY=<key>
S3_SECRET_KEY=<secret>
S3_BUCKET=aisle-documents
S3_REGION=us-east-1

JWT_SECRET=<long-random-secret>

OPENAI_API_KEY=<key>        # or whichever provider you use
DEFAULT_LLM_PROVIDER=openai
DEFAULT_LLM_MODEL=gpt-4o-mini
DEFAULT_EMBEDDING_MODEL=text-embedding-3-small
```

### Build and run (Docker)

```bash
# From the repo root
docker compose --profile full up -d --build
```

Or build the image independently:

```bash
docker build -t aisle-backend ./backend
docker run -p 3000:3000 --env-file .env aisle-backend
```

### CI/CD note — if your production DB pre-dates this migration

If your production database was set up before the `1700000000000-InitialSchema` migration was added to the repo (via `init-db.sql` or an earlier deploy), the migration's idempotency guard handles it automatically — it detects the existing schema and skips. No manual SQL needed.

If for any reason you want to mark it as done manually:

```sql
INSERT INTO migrations (timestamp, name)
VALUES (1700000000000, 'InitialSchema1700000000000')
ON CONFLICT DO NOTHING;
```

---

## Useful URLs

| URL | What it is |
|---|---|
| `http://localhost:3002/health` | Health check — returns `{"status":"ok"}` |
| `http://localhost:3002/api` | API base URL |
| `http://localhost:3002/api/docs` | Swagger UI (dev only) |
| `http://localhost:8080` | Adminer — database browser |
| `http://localhost:9001` | MinIO console (`minio_admin` / `minio_secret`) |
| `http://localhost:6333/dashboard` | Qdrant dashboard |

---

## Common commands

```bash
npm run start:dev        # Start with hot reload (recommended for dev)
npm run build            # Compile TypeScript → dist/
npm run start:prod       # Run compiled production build locally
npm run seed             # Seed a demo tenant, admin user, and sample assistants
npm run backfill:vectors # Re-index all documents into Qdrant (after schema changes)
```

---

## Infrastructure ports (local Docker)

| Container | Host port | Purpose |
|---|---|---|
| aisle-postgres | **5434** | PostgreSQL (not 5432 — avoids local Postgres conflict) |
| aisle-redis | 6379 | Redis |
| aisle-qdrant | 6333 | Qdrant vector DB |
| aisle-minio | 9000 / 9001 | MinIO API / Console |
| aisle-adminer | 8080 | Database browser UI |

---

## Troubleshooting

**`Docker is not installed` or `Docker daemon is not running`**
Install Docker Desktop or start the Docker service, then retry.

**`ECONNREFUSED 127.0.0.1:5434` or `ECONNREFUSED 127.0.0.1:6379`**
Containers aren't running. Start them:
```bash
bash scripts/start-infra.sh
```

**`nest: command not found`**
Run `npm install` first — Nest CLI is a local dev dependency.

**`EADDRINUSE :::3002`**
Something else is on port 3002. Free it:
```bash
lsof -ti :3002 | xargs kill -9
```

**Migration fails in production with "relation already exists"**
The idempotency guard in `1700000000000-InitialSchema` should prevent this. If it still happens, mark the migration as done manually (see CI/CD note above).

**Migrations fail on a fresh local database**
This can happen if `init-db.sql` was applied manually before starting the app. Reset cleanly:
```bash
# From the repo root
docker compose -f docker/docker-compose.yml down -v
bash backend/scripts/start-infra.sh
npm run start:dev
```
