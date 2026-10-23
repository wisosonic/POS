# POS_New: Market Point-of-Sale

A new point-of-sale system for **Darwish Market** (Beirut). It replaces the legacy ASP.NET/SQL Server app and keeps its real transaction history (22,600 sales since Nov 2025).

**Status:** design and test-first scaffolding complete, updated with the owner's decisions (see "Decisions" in [plan.md](plan.md)). No application code yet.

## Goals

- Fast, keyboard- and scanner-driven checkout in **LBP with USD support**
- Receipt printing on a USB 80 mm printer (English/ASCII only)
- Payments by cash (USD/LBP), Whish Money and OMT, recorded with no third-party integration, with opening/closing balances per method
- Credit sales (partial or pay later) for registered customers
- Inventory with a stock ledger, purchasing, returns
- Live dashboard and reports
- Safe under outages: one DB transaction per sale, durable outbox at the till, UPS and backups (the till PC is also the server)
- Secure by default: hashed passwords, RBAC, audit log

## Stack

React 19 + Vite + TypeScript (PWA) · Fastify + TypeScript + Zod · SQLite · Windows service on the till PC · Vitest / Playwright.
Why these choices: [docs/02-decision-table.md](docs/02-decision-table.md).

## Documentation

| Doc | Contents |
|---|---|
| [docs/01-data-analysis.md](docs/01-data-analysis.md) | What's in `POSDB.sql`, its problems, legacy → new mapping, ETL rules |
| [docs/02-decision-table.md](docs/02-decision-table.md) | Technology decisions and checkout business-rule table |
| [docs/03-user-stories.md](docs/03-user-stories.md) | 34 user stories with acceptance criteria |
| [docs/04-architecture.md](docs/04-architecture.md) | Architecture, data model, flows, security, performance targets |
| [docs/05-ui-mockups.md](docs/05-ui-mockups.md) + [mockups/checkout.html](docs/mockups/checkout.html) | Wireframes and a clickable checkout prototype |
| [docs/06-api-spec.md](docs/06-api-spec.md) | REST endpoints, permissions, integrations |
| [docs/07-operations.md](docs/07-operations.md) | Installing on the shop PC, starting at boot, backups, the restore drill, updating |
| [docs/08-security-review.md](docs/08-security-review.md) | What was reviewed, what was fixed, and the risks that remain |
| [docs/10-cutover.md](docs/10-cutover.md) | Moving the shop from the old app to the new one: rehearsal, cut-over day, the first two weeks, rolling back |
| [docs/09-load-test.md](docs/09-load-test.md) | How fast the server is, what slows it, and the proof that money still adds up under load |
| [tests/README.md](tests/README.md) | Test suite, traceability, hardware checklist |
| [plan.md](plan.md) | Milestones, open questions, risks |
| [CLAUDE.md](CLAUDE.md) | Instructions for AI coding assistants working on this repo |

## Repository layout (target)

```
apps/api        Fastify API, DB schema/migrations, ETL
apps/web        React PWA
packages/shared money, pricing, barcode, receipt logic (used by both)
docs/           design documents
tests/          unit · integration · migration · e2e · load
POSDB.sql       legacy dump (157 MB, input to the ETL; do not edit)
Uploads/        legacy product images (709 files)
```

## Getting started

```bash
npm install
npm run lint && npm run typecheck     # pass
npm run test:unit                     # fails until M1 implements packages/shared (test-first)
npm run test:db                       # database schema tests (no Docker needed)
```

Import your legacy data (stop the API first; takes about 10 seconds; safe to run again):

```bash
npm run etl -w @pos/api -- --dump ../../POSDB.sql --db ./data/pos.db   # writes ./data/pos.db.etl-report.json
```

Run the API (creates `./data/pos.db` on first start):

```bash
npm run create-admin -w @pos/api -- admin "a-long-password"   # the first admin has to be created this way
npm run dev -w @pos/api                                       # http://127.0.0.1:3000/api/v1/healthz
```

Run the web app next to it (the API above must be running; the app is at http://localhost:5173):

```bash
npm run dev -w @pos/web
```

On the shop PC the API serves the built app itself, and takes daily backups:

```bash
runner.bat                             # Windows, for trying it out: installs what is needed, makes a test database, starts the server and the screen in this one window, opens the browser
npm run dev                            # the server and the screen together in one terminal ([api] and [web] lines, Ctrl+C stops both)
npm run build                          # builds apps/web/dist
npm run backup -w @pos/api -- --to E:\POS-backups     # a backup now (safe while the shop is open)
npm run restore -w @pos/api -- --from <file> --db <new database file>
npm run rehearse -w @pos/api -- --dump ../../POSDB.sql   # cut-over rehearsal on a throwaway copy (never touches the real database)
npm run preflight -w @pos/api -- --env C:POSservice.env   # is this PC ready for opening day?
```

Installing it to start with Windows, and the backup and restore routine: [docs/07-operations.md](docs/07-operations.md).

## Security notes

- The legacy dump stores **plaintext passwords**. Do not commit it to a shared remote and do not reuse those passwords. The ETL re-hashes them and forces a reset.
- Keep `.env` and database dumps out of version control. Add `POSDB.sql` and `Uploads/` to `.gitignore`.
