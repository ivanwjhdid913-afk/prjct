# Project context

Quality profile: evidence-v1
Language: Russian documentation; Python backend; TypeScript/React frontend

## Repository purpose

This repository contains a local educational web GIS for water bodies in Lipetsk Oblast. It catalogs synthetic water objects and observation points, provides search and map views, and runs scenario calculations for dissolved chloride transport. The project is not a public monitoring system and its demo records are synthetic.

## Architecture map

- `frontend/` — React/Vite UI, state, styling and Playwright browser scenarios.
- `backend/` — FastAPI API, SQLAlchemy/PostGIS models, migrations, seed data and tests.
- `compose.yaml` — PostgreSQL/PostGIS, backend and frontend development services.
- `docs/` — project documentation and durable agent memory.

The frontend talks to the backend through `/api`. The scenario calculation is a separate Python module and does not require database access for the calculation itself.

## Confirmed boundaries and invariants

- `.env` is local-only and must never be committed.
- Demo water bodies and points are synthetic; do not describe them as real measurements or stations.
- Database changes are applied through migrations.
- Before changing behavior, preserve the existing API contracts, saved formats, and documented migration compatibility.
- Do not use `docker compose down -v` unless intentional database-volume deletion is explicitly approved.

## Verification

Backend checks use the project test commands documented in `README.md`. Frontend behavior is verified with Playwright from `frontend/`. For a change, run the narrowest relevant checks first, then the broader suite when practical.

## Memory locations

- Stable project context: this file.
- Stable feature context: [`docs/specs/README.md`](../specs/README.md).
- Change history: [`docs/changes/README.md`](../changes/README.md).
- Ledger runtime/configuration: [`.context-ledger/`](../../.context-ledger/).
