<p align="center">
  <img src="client/public/logo.svg" alt="Oblidesk" height="80">
</p>

<h3 align="center">Self-hosted Ticketing &amp; Service Desk</h3>

<p align="center">
  Configurable ticket engine, business-hours SLA clocks, alert-driven intake,
  and an audit trail that explains every automated decision.
  <br>
  Part of the <a href="https://obli.tools"><strong>obli.tools</strong></a> ecosystem.
</p>

---

Oblidesk is the ticketing app of the Obli* suite. Tickets arrive from the web portal, from a
mailbox, or straight from the other Obli* apps — an Obliguard ban, an Obliview outage, an
Oblimap site event — and land in a queue with a priority and an SLA clock decided by rules you
own. Every one of those automated decisions is recorded, so a ticket can always answer
**"why?"**.

## Features at a Glance

- **Configurable ticket engine** — statuses, priorities, forms, queues, views: all data, editable
  in the UI, exportable and importable between tenants (references are by slug, so nothing breaks)
- **Eight status categories, always** — a status can be named anything, but it is always one of
  `new · open · pending_requester · pending_third_party · scheduled · resolved · closed · cancelled`,
  and every engine keys off the category. Rename freely, nothing silently stops working.
- **Business-hours SLA clocks** — per-policy calendars with holidays; clocks pause automatically
  while you're waiting on the requester or a third party; at-risk and breach events in real time
- **Rules engine** — when / if / then automation with a visual builder that can dry-run a rule
  against a real ticket and get exactly the answer the server would give
- **Decision log** — routing, priority, SLA, assignment, escalation, approval, rules and alert
  binding each write an append-only record on the same code path as the action. The ticket's
  "Why?" panel is a straight read of it — nothing is reconstructed after the fact.
- **Alert intake from the whole suite** — sibling apps push alerts; bindings decide whether an
  alert opens a ticket, attaches to an existing one, or is swallowed as a duplicate. Alert storms
  collapse onto a single ticket.
- **Rewind** — every ticket stores `occurred_at` ("when did it actually happen?") separately from
  `created_at`, so an outage that started at 02:14 and was ticketed at 08:30 keeps 02:14 — and the
  linked configuration items can be shown as they stood at that moment.
- **Configuration items, projected** — agents, monitors and sites mirrored from the sibling apps,
  linked to tickets, with full ticket history per CI
- **Email intake** — IMAP polling, threading onto existing tickets, inline images and attachments
- **Attachments on disk** — content-addressed by SHA-256, refcounted, scoped per tenant; the
  database keeps metadata only
- **Fast multilingual search** — Postgres full-text (`simple` dictionary) with `unaccent` and
  trigram fuzzy matching; no external search service, no vector database
- **Optimistic concurrency** — two agents editing the same ticket never silently overwrite each
  other; the loser gets a conflict with the current row and rebases
- **Approvals** — multi-step approval flows with delegation and expiry
- **Multi-tenant workspaces** — isolated tenants with per-workspace roles
- **Teams &amp; RBAC** — read-only / read-write per queue
- **2FA** — TOTP authenticator apps + email OTP
- **Obligate SSO** — single sign-on across the whole suite, tenants matched by slug
- **Real-time** — Socket.io live ticket, queue-count and SLA updates
- **English &amp; French UI**

---

## How It Works

1. **Intake** — a ticket is created from the portal, from an email, or from an alert pushed by a
   sibling app. Intake captures `occurred_at` — when the problem happened, not when it was typed.
2. **Routing** — routing rules pick the queue and, optionally, the assignee. The choice is logged.
3. **Priority** — priority rules score the ticket (impact × urgency, CI criticality, requester
   VIP…). The inputs and the outcome are logged.
4. **SLA** — the matching SLA policy starts first-response / resolution clocks against a business
   calendar. Clocks pause on `pending_*` and `scheduled` statuses.
5. **Work** — agents edit fields inline (each field autosaves on its own, nothing blocks you) and
   move the ticket through statuses. Required fields are enforced only at the transition — by the
   same evaluator the UI used to grey out the button.
6. **Explain** — the "Why?" panel replays every automated decision with the config version that
   produced it.

---

## Installation

### One-liner

```sh
curl -fsSL https://raw.githubusercontent.com/MeeJay/oblidesk/main/install.sh | sh
```

Creates `./oblidesk`, generates secrets into `.env`, and starts the stack.

### Docker Compose (built-in PostgreSQL)

```bash
curl -fsSL https://raw.githubusercontent.com/MeeJay/oblidesk/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/MeeJay/oblidesk/main/.env.example -o .env
# edit .env — at minimum SESSION_SECRET, DB_PASSWORD and ENCRYPTION_KEY
mkdir -p custom/attachments
docker compose up -d
```

### Docker Compose (external PostgreSQL)

```bash
docker compose -f docker-compose.external-db.yml up -d
```

Set `DATABASE_URL` in your `.env` to point at your existing PostgreSQL instance. Create the
database first; Oblidesk creates its own schema (migrations run at boot) but not the database.

### Updating

```bash
docker compose pull && docker compose up -d
```

---

## First Login

| | |
|---|---|
| **URL** | `http://<host>:3004` |
| **User** | `admin` |
| **Password** | `admin123` |

Change the password immediately after the first login. Then, in order:

1. **Admin → Tenants** — create your first tenant (its **slug** is the identity the rest of the
   suite joins on, so pick it deliberately: it must match the tenant slug used in the sibling apps)
2. **Configuration → Statuses / Priorities** — the seeded defaults cover the eight categories;
   rename them to your vocabulary
3. **Configuration → Queues and Forms** — one queue per team, one form per request type
4. **Configuration → Calendars and SLA policies** — business hours first, then the targets
5. **Configuration → Rules** — routing and automation; dry-run each rule before enabling it

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OBLIDESK_VERSION` | Docker Hub image tag | `latest` |
| `DB_PASSWORD` | Password for the bundled PostgreSQL container | `changeme` |
| `DATABASE_URL` | PostgreSQL connection string (external-db compose file) | `postgres://oblidesk:changeme@postgres:5432/oblidesk` |
| `SESSION_SECRET` | Session signing secret | — |
| `ENCRYPTION_KEY` | AES-256 key (64 hex chars) for stored mailbox / integration credentials | — |
| `PORT` | Server port inside the container | `3001` |
| `LISTEN_PORT` | Host port the web UI is published on | `3004` |
| `NODE_ENV` | `production` or `development` | `production` |
| `CLIENT_ORIGIN` | CORS origin for the client | `http://localhost` |
| `APP_NAME` | Branding + prefix in notification messages | `Oblidesk` |
| `DEFAULT_ADMIN_USERNAME` | Admin account created on first run | `admin` |
| `DEFAULT_ADMIN_PASSWORD` | Admin password on first run | `admin123` |
| `CUSTOM_DIR` | Host path mounted at `/custom` — the attachment blob store | `./custom` |

`ENCRYPTION_KEY` is not optional in practice: without it, mailbox and integration credentials
cannot be stored. Generate it once with `openssl rand -hex 32` and **keep it** — changing it makes
every previously stored secret unreadable.

### Ports

| Component | Port |
|-----------|------|
| Web UI (Nginx) | `3004` on the host → `80` in the container |
| Server (internal) | `3001` |
| PostgreSQL | `5432`, container-internal (uncomment the mapping in `docker-compose.yml` to expose it) |

### Persistence

| What | Where |
|------|-------|
| Database | the `postgres_data` Docker volume |
| Attachments | `${CUSTOM_DIR:-./custom}/attachments` on the host |

Attachments live on disk, not in the database — back up **both**, or a restore gives you tickets
whose attachments 404.

---

## Obligate SSO

Oblidesk authenticates against [Obligate](https://github.com/MeeJay/Obligate), the suite's SSO
provider. Users sign in once and reach every Obli* app; tenants, roles and capabilities come from
the assertion.

**In Obligate:**

1. **Admin → Applications → Add application**
2. Type: `oblidesk` · Name: `Oblidesk` · URL: `http://<host>:3004`
3. Redirect URI: `http://<host>:3004/auth/callback`
4. Copy the generated **API key**
5. **Admin → Permission groups** — grant the relevant groups access to the Oblidesk app, and give
   each group its per-tenant role

**In Oblidesk:**

6. **Admin → Configuration → Obligate SSO**
7. Paste the Obligate URL and the API key, then enable SSO
8. Save — the page shows a reachability check; a green result means the login page will offer
   "Sign in with Obligate"

**Then, once:**

9. Make sure each tenant's **slug** is identical on both sides. The assertion carries tenant
   slugs, and Oblidesk maps them onto its own tenants by slug — numeric ids differ between apps
   and are never used for this.

Local login keeps working alongside SSO, so you are never locked out if Obligate is down.

---

## Suite Integration

| Source app | What it sends | What Oblidesk does |
|------------|---------------|--------------------|
| **Obliguard** | Ban / attack alerts | Opens or joins a security ticket, links the agent CI |
| **Obliview** | Monitor down / recovered | Opens an outage ticket at the real outage time, auto-resolves on recovery if the binding says so |
| **Oblimap** | Site / link events | Opens a field ticket, links the site CI |
| **Obliance** | Compliance findings | Opens a remediation ticket with the finding attached |
| **Obligate** | Identity | SSO, tenants, roles, capabilities |

Alerts are matched to tenants **by slug**, deduplicated by key, and bound by configuration —
never hard-coded.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Server** | Node.js 24 LTS, TypeScript, Express |
| **Database** | PostgreSQL 16, Knex (migrations + query builder) |
| **Search** | PostgreSQL full-text (`simple` + `unaccent` + `pg_trgm`) |
| **Real-time** | Socket.io |
| **Mail** | imapflow + mailparser (in), nodemailer (out) |
| **Client** | React 18, Vite, Tailwind CSS, Zustand |
| **Monorepo** | npm workspaces (`shared/`, `server/`, `client/`) |

---

> **An experiment with Claude Code**
>
> This project was built as an experiment to see how far Claude Code could be pushed as a
> development tool. Claude was used as a coding assistant throughout the entire development
> process.

<p align="center">
  <a href="https://obli.tools">obli.tools</a>
</p>
