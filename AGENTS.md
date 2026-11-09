# Project agent guide

## Source of truth

Read [`docs/ai/project-context.md`](docs/ai/project-context.md) before making behavior-changing changes. Keep durable project knowledge in `docs/ai/`, stable feature context in `docs/specs/`, and verified change records in `docs/changes/`.

## Project shape

- `frontend/` — React/Vite interface and Playwright browser tests.
- `backend/` — FastAPI, PostgreSQL/PostGIS integration, migrations, seed and tests.
- `compose.yaml` — local development services.

## Safety rules

- Never commit `.env`, credentials, or generated database data.
- Preserve synthetic-data labeling; do not present demo records as real observations.
- Before changing behavior, update the relevant context or change record.
- Prefer the project commands documented in `README.md` and verify affected backend/frontend tests.

## Memory workflow

After a behavior-changing feature or fix, record what changed, why, affected paths, verification, and remaining limitations in `docs/changes/`. Keep `docs/ai/project-context.md` factual and current.
