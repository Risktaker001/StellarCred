# StellarCred Indexer

The indexer watches the `ProofRegistry` Soroban contract for `proof_submitted` and `proof_revoked` events, stores them in a local database (SQLite or Postgres), and exposes a read-only HTTP API for protocol integrations that need indexed claim data without querying the chain directly.

## Quick start

```bash
cp .env.example .env
# Fill in PROOF_REGISTRY_CONTRACT_ID and adjust DB settings

npm run build
npm start
```

Or with Docker:

```bash
docker compose up indexer
```

## Configuration

All configuration is via environment variables. See `.env.example` for the full list with descriptions.

| Variable | Default | Required |
|---|---|---|
| `PROOF_REGISTRY_CONTRACT_ID` | — | ✅ |
| `DB_DRIVER` | `sqlite` | |
| `SQLITE_PATH` | `./data/indexer.db` | |
| `DATABASE_URL` | — | When `DB_DRIVER=postgres` |
| `RPC_URL` | testnet RPC | |
| `STELLAR_NETWORK` | `testnet` | |
| `POLL_INTERVAL_SECONDS` | `6` | |
| `START_LEDGER` | `0` | |
| `PORT` | `3001` | |
| `API_KEY` | _(unset)_ | |
| `CORS_ORIGIN` | `*` | |

## API endpoints

All responses are `application/json`. There are no write endpoints.

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check. Returns `{ status: "ok", lastLedger: N }`. |
| `GET /claims?wallet=G…` | All claims (active and revoked) for a single wallet address. |
| `GET /stats` | Aggregate counts per credential type: total, active, revoked. |
| `GET /recent?limit=20&page=1` | Paginated list of recent verifications across all wallets. `limit` max 100. |

## Authentication

The indexer ships in **public mode** by default: all endpoints are open with no credentials required. This is the right choice for operators who want permissionless read access matching the on-chain data model.

### Enabling authenticated mode

Set the `API_KEY` environment variable to a strong random secret:

```bash
# Generate a key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Add to your environment
API_KEY=<generated-value>
```

In authenticated mode, requests to `/claims`, `/stats`, and `/recent` must include the key using either of these headers:

```
Authorization: Bearer <key>
X-API-Key: <key>
```

### Per-endpoint policy

| Endpoint | Public mode | Authenticated mode |
|---|---|---|
| `GET /health` | ✅ open | ✅ always open — no credentials needed |
| `GET /claims` | ✅ open | 🔒 requires key |
| `GET /stats` | ✅ open | 🔒 requires key |
| `GET /recent` | ✅ open | 🔒 requires key |

`/health` is intentionally never gated so that readiness probes, load balancers, and uptime monitors work without credentials.

### Error responses in authenticated mode

| Situation | Status | Body |
|---|---|---|
| No token supplied | `401` | `{ "error": "authentication required" }` |
| Token present but wrong | `401` | `{ "error": "invalid API key" }` |

Both cases return `401` (not `403`) to avoid confirming whether the key exists.

## Privacy trade-offs

Claim data is not secret in the cryptographic sense — every record is derived from public Soroban contract events that anyone with RPC access can read. Running the indexer in public mode exposes the same information that is already on-chain.

However, **indexed access is qualitatively different from raw chain access**:

- **Correlation at scale.** `/recent` lets a single caller enumerate every verified wallet by iterating pages. Doing the same from raw chain data requires replaying every block — significantly more effort.
- **Per-wallet history.** `/claims` returns the full claim history for any address including revoked credentials and timestamps, making it easier to build a timeline of a holder's activity than querying each ledger individually.
- **Aggregation.** `/stats` reveals the total number of verified holders per credential type across the whole network — useful for scrapers profiling adoption.

### When to run in public mode

Public mode is appropriate when:

- You are running a community or protocol indexer intended to be permissionlessly composable.
- Your deployment is for a public-facing dApp whose SDK reads claim status on behalf of users.
- The total number of verified wallets is publicly acknowledged anyway (e.g. in a published dashboard).

### When to enable authentication

Consider authenticated mode when:

- You are running an internal indexer for your own protocol and do not want third parties bulk-scanning your deployment.
- You want to limit `/recent` enumeration to known protocol partners.
- Your deployment is on a private network or internal infrastructure.

Authentication does not make claim data _secret_ — any party with direct RPC access to the Stellar network can still replay events and build the same index. It makes bulk access to _your_ index require a credential, which raises the effort for casual scraping.

### Restricting CORS in authenticated mode

When `API_KEY` is set and your callers are browser-based, set `CORS_ORIGIN` to your specific front-end origins rather than `*`. This prevents a malicious page from tricking a user's browser into sending their stored key to your indexer:

```bash
CORS_ORIGIN=https://app.example.com
```

`*` is safe in public mode (no credentials to steal) but should be narrowed in authenticated deployments.

## Running tests

```bash
npm test
```

Tests use an in-memory SQLite database and do not require any network access or running services.
