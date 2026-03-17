# Technician Lifecycle Management Service

A service that keeps the platform's technician roster in sync with Point-of-Sale systems like ServiceTitan, handling the full lifecycle of technician accounts - departures, new hires, phone number reassignments, and returns - while protecting financial accounts and maintaining data integrity.

## Setup

### Prerequisites
- Docker and Docker Compose

### Running

```bash
docker-compose up --build
```

This starts three services:
- **App** (port 3000) - The lifecycle management service + API + dashboard
- **PostgreSQL** (port 5432) - Database with auto-migration and seeding
- **Mock ServiceTitan** (port 3001) - Simulates the ServiceTitan API with realistic test data

Once running:
- **Dashboard**: http://localhost:3000/dashboard
- **Health check**: http://localhost:3000/health
- **Trigger sync**: `POST http://localhost:3000/api/sync`
- **View pending reviews**: `GET http://localhost:3000/api/reviews`

### Running Tests

```bash
# With the database running (docker-compose up db)
npm install
npm test              # All tests
npm run test:unit     # Unit tests only (no DB needed)
npm run test:integration  # Integration tests (requires DB)
```

---

## Written Summary

### 1. Schema Changes - What and Why

**New tables added:**

| Table | Purpose |
|-------|---------|
| `sync_runs` | Audit trail of every sync cycle - when it ran, what happened, whether it succeeded |
| `sync_events` | Granular events within each sync (departures, onboardings, conflicts detected) |
| `technician_status_changes` | Lifecycle state transitions with human review workflow |
| `phone_number_audit` | Complete history of phone number assignments, releases, and conflicts |

**New columns on `users`:**

| Column | Purpose |
|--------|---------|
| `deactivated_at` | When the technician was deactivated |
| `deactivation_reason` | Why (auto-sync, manual, etc.) |
| `last_known_phone` | Preserves the phone number at time of departure so we can detect reassignment |
| `last_synced_at` | When the PoS sync last touched this user |

**Why these changes:**

The core insight is that the platform uses phone numbers as identity, but phone numbers are *not* stable identifiers in the home services industry - they get reassigned when technicians leave. The schema changes create a system that:

1. **Decouples phone from identity on departure** - When a tech is deactivated, their phone is released (`cell_phone = NULL`) but preserved in `last_known_phone`. This means the phone is immediately available for a new hire, and no two active users ever share a phone.

2. **Creates a complete audit trail** - Every phone number change is tracked in `phone_number_audit`. When a support ticket comes in saying "Jane's ServiceTitan activity is showing on John's account," operations can trace exactly what happened.

3. **Separates what's automated from what needs a human** - `technician_status_changes.requires_review` creates a work queue for the ops team.

**Alternatives considered:**
- *Soft-delete approach* (keeping phone but marking user inactive): Rejected because it doesn't solve the phone uniqueness problem. Two users would share a phone in the system, which is exactly the bug described in the case study.
- *Separate identity table* (decoupling phone from user entirely): More theoretically correct, but would require rewriting the platform's auth system. Too invasive for the immediate problem.
- *Using PoS technician ID as primary identity*: Only works for PoS-integrated companies. Many the platform users aren't on ServiceTitan.

### 2. Automation vs. Human Review - Decision Framework

The guiding principle: **automate when the action is safe and reversible; flag for human review when the stakes involve money or identity.**

| Scenario | Decision | Reasoning |
|----------|----------|-----------|
| Tech deactivated in PoS | **Auto-resolve**: deactivate + release phone | Safe. The PoS is the source of truth for employment status. Releasing the phone prevents the identity conflict problem. |
| New tech, no phone conflict | **Auto-resolve**: create account | Low risk. Clean onboarding with no ambiguity. |
| New tech, phone belongs to active user | **Flag for review** | High risk. This is the Jane Doe / John Doe scenario. Auto-resolving could link the wrong Stripe financial account. The $50 referral fee going to the wrong person is a real financial loss. |
| Tech returns, no phone conflict | **Auto-resolve**: reactivate | Safe. Same person, same PoS ID, phone is available. |
| Tech returns, phone is taken | **Flag for review** | Ambiguous. Need a human to decide: does the returning tech get a new phone, or does the current holder need to change? |
| Tech missing from PoS entirely | **Flag for review** | Could be a data issue (partial API response) rather than a real departure. Safer to let a human verify. |

**Tradeoffs:**
- More automation = fewer support tickets but higher risk of incorrect financial linkage
- More human review = slower onboarding but catches the edge cases that cost real money
- Current calibration errs on the side of safety for anything involving phone numbers or Stripe accounts

### 3. Scaling to 10,000 Companies

Current architecture handles tens of companies well (sequential sync per company, single database). At 10,000 companies:

**What would need to change:**

1. **Parallel sync with job queues**: Replace the cron-based sequential loop with a job queue (Bull/BullMQ + Redis, or AWS SQS). Each company sync becomes an independent job. Workers process companies in parallel, with configurable concurrency.

2. **Database connection pooling & read replicas**: The dashboard queries become expensive at scale. Add read replicas for the dashboard/reporting queries. The sync engine writes to primary.

3. **Rate limiting per PoS provider**: ServiceTitan likely has API rate limits. Need per-tenant rate limiting so one company's large roster doesn't starve others. Token bucket per tenant.

4. **Sharding the sync schedule**: Not all 10,000 companies need to sync simultaneously. Distribute syncs across the interval window (e.g., company A syncs at :00, company B at :01, etc.) to smooth the load.

5. **Event-driven architecture**: Instead of polling all companies every 15 minutes, track which companies have had recent PoS activity and prioritize those. Companies with stable rosters can sync less frequently.

6. **Separate the review service**: The human review workflow becomes its own microservice with its own database, communicating via events. The sync engine emits events; the review service consumes them.

### 4. Measuring Impact

To know if this system is actually reducing the problems from Part 1:

**Primary metrics (directly tied to the problems):**

| Metric | What it measures | Target |
|--------|-----------------|--------|
| Support tickets for phone/account issues per week | Direct problem reduction | < 1/week (from 5-10) |
| Time from technician departure to phone release | How fast we prevent identity conflicts | < 15 min (sync interval) |
| Number of active phone number conflicts | Zero-tolerance enforcement | 0 |
| Stranded earnings incidents per month | Departed techs unable to access money | 0 |

**Secondary metrics (system health):**

| Metric | What it measures |
|--------|-----------------|
| Sync success rate | % of sync runs completing without error |
| Avg sync duration per company | Performance degradation early warning |
| Review items resolved per day | Ops team throughput |
| Avg time from flag to resolution | How fast ambiguous cases are handled |
| Auto-resolve rate | % of changes handled without human intervention |

**Lagging indicators:**

| Metric | What it measures |
|--------|-----------------|
| Technician turnover rate by company | Is 30% industry average holding? |
| Time to onboard new technician | Are phone conflicts blocking onboarding? |
| Stale "active" technician count | Are departed techs being caught? |

### 5. Assumptions

1. **Phone numbers are US-only** - Normalized to E.164 US format (+1XXXXXXXXXX). International support would require a more sophisticated normalization library.

2. **PoS technician ID is stable** - We assume ServiceTitan's technician ID doesn't change for the same person. This is how we match a PoS record to a the platform user across syncs.

3. **One company per PoS tenant** - Each the platform company maps to exactly one ServiceTitan tenant. A franchise model (one tenant, many companies) would need different logic.

4. **Sync interval of 15 minutes is acceptable** - Since ServiceTitan has no webhooks, we poll. 15 minutes means a departing tech's phone could be in conflict for up to 15 minutes. For the case study scenarios, this is fine.

5. **Stripe account should survive departure** - The case study mentions "forfeited earnings" as a problem. We intentionally do NOT unlink the Stripe Connect account when a tech departs. The departed tech should be able to claim their accumulated earnings through a support flow.

6. **The sync engine handles one PoS provider at a time** - Adding Housecall Pro requires only implementing the `PoSProvider` interface and registering it. No changes to sync logic needed.

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  ServiceTitan │────▶│  PoS Provider    │     │  Housecall   │
│  (Mock API)  │     │  Abstraction     │◀────│  Pro (future) │
└──────────────┘     └────────┬─────────┘     └──────────────┘
                              │
                    ┌─────────▼──────────┐
                    │    Sync Engine      │
                    │  (core business     │
                    │   logic)            │
                    └─────────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌────────────┐  ┌───────────────┐  ┌──────────┐
     │ PostgreSQL  │  │ Review Queue  │  │ Audit    │
     │ (users,     │  │ (flagged      │  │ Trail    │
     │  companies) │  │  items)       │  │ (phone,  │
     └─────┬──────┘  └───────┬───────┘  │  sync)   │
           │                 │          └──────────┘
           ▼                 ▼
     ┌──────────────────────────────────┐
     │         REST API                 │
     │  /api/sync    /api/reviews       │
     │  /health      /dashboard         │
     └─────────────┬────────────────────┘
                   ▼
     ┌──────────────────────────────────┐
     │    Operations Dashboard (UI)     │
     └──────────────────────────────────┘
```

**Key design decisions:**
- **Provider pattern**: PoS providers implement a simple interface (`fetchTechnicians`). Adding Housecall Pro means creating one new file - zero changes to sync logic.
- **Transaction boundaries**: Each company sync runs inside a single database transaction. If anything fails mid-sync, all changes for that company roll back (no partial state).
- **Idempotent sync**: Running the sync engine twice produces the same result. Already-deactivated techs aren't re-processed. Already-onboarded techs aren't duplicated.
