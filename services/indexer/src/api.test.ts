/**
 * api.test.ts — Unit tests for the HTTP API layer.
 *
 * Uses an in-memory SQLite database (via the real db adapter) so tests are
 * fully self-contained and require no network access.
 */

import request from "supertest";
import type { Application } from "express";
import { buildApp, serializeClaim } from "./api";
import { createSqliteDb } from "./db";
import type { Db, ClaimRow } from "./db";
import type { Config } from "./config";
import type { Ingester, IngesterHealth, IngesterMetrics } from "./ingester";

import os from "os";
import path from "path";
import fs from "fs";

let db: Db;
let app: Application;
let tmpFile: string;

/** Minimal ingester stub that exposes a controllable health snapshot. */
function makeIngester(overrides?: Partial<IngesterHealth>): Ingester {
  const health: IngesterHealth = {
    lastSuccessLedger: 0,
    headLedger: 0,
    lag: -1,
    lastError: null,
    lastErrorTime: null,
    consecutiveErrors: 0,
    fetchAttempts: 0,
    fetchFailures: 0,
    ...overrides,
  };
  const metrics: IngesterMetrics = {
    eventsProcessedTotal: 0,
    fetchErrorsTotal: 0,
    uptimeSeconds: 0,
    dbWriteLatencySeconds: 0,
    lag: -1,
    ...overrides,
  };
  return {
    tick: async () => 0,
    reconcile: async () => 0,
    start: () => {},
    stop: () => {},
    shutdown: async () => {},
    getHealth: () => ({ ...health }),
    getMetrics: () => ({ ...metrics }),
  };
}

function makeConfig(sqlitePath: string): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath,
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    corsOrigins: ["http://localhost:3000"],
    rateLimitWindowMs: 60000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
    apiKey: undefined,
  };
}

beforeEach(() => {
  // Use a unique temp file per test so each test gets a fresh DB
  tmpFile = path.join(os.tmpdir(), `indexer-test-${Date.now()}-${Math.random()}.db`);
  db = createSqliteDb(makeConfig(tmpFile));
  db.migrate();
  app = buildApp(db, makeIngester());
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpFile + "-wal"); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpFile + "-shm"); } catch { /* ignore */ }
});

// ── /health ─────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with status ok and lastLedger 0 on empty db", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      lastLedger: 0,
      headLedger: 0,
      lag: -1,
      consecutiveErrors: 0,
      lastError: null,
    });
  });

  it("reports degraded when consecutiveErrors is 1-2", async () => {
    app = buildApp(db, makeIngester({ consecutiveErrors: 2, lastError: "timeout" }));
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.consecutiveErrors).toBe(2);
    expect(res.body.lastError).toBe("timeout");
  });

  it("reports error when consecutiveErrors >= 3", async () => {
    app = buildApp(db, makeIngester({ consecutiveErrors: 5, lag: 120 }));
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(res.body.lag).toBe(120);
  });
});

// ── /claims ──────────────────────────────────────────────────────────────────

describe("GET /claims", () => {
  it("returns 400 when wallet param is missing", async () => {
    const res = await request(app).get("/claims");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wallet/i);
  });

  it("returns empty claims array for unknown wallet", async () => {
    const res = await request(app).get("/claims?wallet=GUNKNOWN");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wallet: "GUNKNOWN", claims: [] });
  });

  it("returns inserted claim for known wallet", async () => {
    (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 42,
      threshold: null,
      revoked: 0,
    });

    const res = await request(app).get("/claims?wallet=GALICE");
    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0]).toMatchObject({
      wallet: "GALICE",
      credential_type: "kyc",
      revoked: 0,
    });
  });
});

// ── /stats ────────────────────────────────────────────────────────────────────

describe("GET /stats", () => {
  it("returns empty stats array on empty db", async () => {
    const res = await request(app).get("/stats");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stats: [] });
  });

  it("aggregates counts per credential_type", async () => {
    const base = {
      issuer: "GISSUER",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 1,
      threshold: null,
      revoked: 0,
    };
    (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      ...base, wallet: "GA1", credential_type: "kyc",
    });
    (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      ...base, wallet: "GA2", credential_type: "kyc",
    });
    (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      ...base, wallet: "GA3", credential_type: "age",
    });

    const res = await request(app).get("/stats");
    expect(res.status).toBe(200);
    const kycRow = res.body.stats.find(
      (r: { credential_type: string }) => r.credential_type === "kyc"
    );
    expect(kycRow).toMatchObject({ total: 2, active: 2, revoked: 0 });
  });
});

// ── /recent ───────────────────────────────────────────────────────────────────
// /recent uses keyset (cursor) pagination ordered by (ledger_sequence DESC,
// id DESC): the response carries an opaque nextCursor that must be echoed back
// as ?cursor= for the next page. These tests pin the stability guarantees that
// OFFSET pagination could not provide — no duplicates, no skipped rows, even
// when claims are ingested between page requests.

describe("GET /recent", () => {
  const base = {
    issuer: "GISSUER",
    credential_type: "kyc",
    expiry: 9999999,
    threshold: null,
    revoked: 0,
  };

  function seed(
    rows: Array<{ wallet: string; verified_at: number; ledger_sequence: number }>
  ) {
    const dbc = db as ReturnType<typeof createSqliteDb>;
    for (const r of rows) {
      dbc.upsertClaim({ ...base, ...r });
    }
  }

  it("returns an empty page with nextCursor null when db is empty", async () => {
    const res = await request(app).get("/recent");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claims: [], limit: 20, nextCursor: null });
  });

  it("excludes revoked claims", async () => {
    seed([
      { wallet: "GA1", verified_at: 1000, ledger_sequence: 1 },
      { wallet: "GA2", verified_at: 1000, ledger_sequence: 1 },
    ]);
    (db as ReturnType<typeof createSqliteDb>).revokeClaim("GA1", "kyc");

    const res = await request(app).get("/recent");
    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0].wallet).toBe("GA2");
  });

  it("clamps limit to MAX_LIMIT and falls back to the default for invalid values", async () => {
    const clamped = await request(app).get("/recent?limit=9999");
    expect(clamped.status).toBe(200);
    expect(clamped.body.limit).toBe(100);

    const invalid = await request(app).get("/recent?limit=abc");
    expect(invalid.status).toBe(200);
    expect(invalid.body.limit).toBe(20);
  });

  it("paginates by cursor: every claim exactly once, newest first", async () => {
    seed([
      { wallet: "GA1", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA2", verified_at: 2000, ledger_sequence: 20 },
      { wallet: "GA3", verified_at: 3000, ledger_sequence: 30 },
      { wallet: "GA4", verified_at: 4000, ledger_sequence: 40 },
      { wallet: "GA5", verified_at: 5000, ledger_sequence: 50 },
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (pages < 10) {
      const res = await request(app).get(
        cursor ? `/recent?limit=2&cursor=${encodeURIComponent(cursor)}` : "/recent?limit=2"
      );
      expect(res.status).toBe(200);
      expect(res.body.claims.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.claims.map((c: { wallet: string }) => c.wallet));
      cursor = res.body.nextCursor as string | null;
      pages++;
      if (cursor === null) break;
    }

    expect(seen).toEqual(["GA5", "GA4", "GA3", "GA2", "GA1"]);
  });

  it("stays stable when claims are inserted between page requests", async () => {
    seed([
      { wallet: "GA1", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA2", verified_at: 2000, ledger_sequence: 20 },
      { wallet: "GA3", verified_at: 3000, ledger_sequence: 30 },
    ]);

    const page1 = await request(app).get("/recent?limit=2");
    expect(page1.body.claims.map((c: { wallet: string }) => c.wallet)).toEqual([
      "GA3",
      "GA2",
    ]);

    seed([{ wallet: "GANEW", verified_at: 6000, ledger_sequence: 60 }]);
    seed([{ wallet: "GA0", verified_at: 500, ledger_sequence: 5 }]);

    const page2 = await request(app).get(
      `/recent?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`
    );
    expect(page2.body.claims.map((c: { wallet: string }) => c.wallet)).toEqual([
      "GA1",
      "GA0",
    ]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("uses the id tiebreaker to page through claims that share a ledger", async () => {
    seed([
      { wallet: "GA1", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA2", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA3", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA4", verified_at: 1000, ledger_sequence: 10 },
    ]);

    const page1 = await request(app).get("/recent?limit=2");
    expect(page1.body.claims).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await request(app).get(
      `/recent?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`
    );
    expect(page2.body.claims).toHaveLength(2);
    expect(page2.body.nextCursor).toBeNull();

    const wallets = [...page1.body.claims, ...page2.body.claims].map(
      (c: { wallet: string }) => c.wallet
    );
    expect(new Set(wallets).size).toBe(4);
    expect(wallets.sort()).toEqual(["GA1", "GA2", "GA3", "GA4"]);
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await request(app).get("/recent?cursor=not-a-real-cursor");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid cursor");
  });
});

// ── /issuers/:issuer/stats ───────────────────────────────────────────────────

describe("GET /issuers/:issuer/stats", () => {
  it("returns a zeroed row for an issuer with no indexed claims", async () => {
    const res = await request(app).get("/issuers/GUNKNOWN/stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issuer: "GUNKNOWN",
      total: 0,
      active: 0,
      revoked: 0,
      credential_types: [],
      first_seen: null,
    });
  });

  it("aggregates total/active/revoked, credential types, and first_seen across an issuer's claims", async () => {
    const dbc = db as ReturnType<typeof createSqliteDb>;
    dbc.upsertClaim({
      wallet: "GA1",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 2000,
      expiry: 9999999,
      ledger_sequence: 1,
      threshold: null,
      revoked: 0,
    });
    dbc.upsertClaim({
      wallet: "GA2",
      credential_type: "age",
      issuer: "GISSUER",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 2,
      threshold: 21,
      revoked: 0,
    });
    dbc.upsertClaim({
      wallet: "GA3",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 3000,
      expiry: 9999999,
      ledger_sequence: 3,
      threshold: null,
      revoked: 0,
    });
    dbc.revokeClaim("GA3", "kyc");

    const res = await request(app).get("/issuers/GISSUER/stats");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe("GISSUER");
    expect(res.body.total).toBe(3);
    expect(res.body.active).toBe(2);
    expect(res.body.revoked).toBe(1);
    expect(res.body.credential_types.sort()).toEqual(["age", "kyc"]);
    expect(res.body.first_seen).toBe(1000);
  });

  it("does not mix up claims from a different issuer", async () => {
    const dbc = db as ReturnType<typeof createSqliteDb>;
    dbc.upsertClaim({
      wallet: "GA1",
      credential_type: "kyc",
      issuer: "GISSUER_A",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 1,
      threshold: null,
      revoked: 0,
    });
    dbc.upsertClaim({
      wallet: "GA2",
      credential_type: "kyc",
      issuer: "GISSUER_B",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 2,
      threshold: null,
      revoked: 0,
    });

    const res = await request(app).get("/issuers/GISSUER_A/stats");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it("returns 400 for an empty issuer path parameter", async () => {
    const res = await request(app).get("/issuers/%20/stats");
    expect(res.status).toBe(400);
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────

describe("unknown routes", () => {
  it("returns 404 for unknown path", async () => {
    const res = await request(app).get("/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ── CORS & Rate Limiting Integration ─────────────────────────────────────────

describe("CORS & Rate Limiting integration in API", () => {
  it("emits CORS headers for allowed origin and handles preflight", async () => {
    const customConfig = {
      ...makeConfig(tmpFile),
      corsOrigins: ["https://app.stellarcred.xyz"],
    };
    const customApp = buildApp(db, makeIngester(), customConfig);

    const getRes = await request(customApp)
      .get("/health")
      .set("Origin", "https://app.stellarcred.xyz");
    expect(getRes.status).toBe(200);
    expect(getRes.headers["access-control-allow-origin"]).toBe(
      "https://app.stellarcred.xyz"
    );

    const optRes = await request(customApp)
      .options("/claims")
      .set("Origin", "https://app.stellarcred.xyz")
      .set("Access-Control-Request-Method", "GET");
    expect(optRes.status).toBe(204);
    expect(optRes.headers["access-control-allow-origin"]).toBe(
      "https://app.stellarcred.xyz"
    );
  });

  it("does not emit CORS headers for untrusted origins", async () => {
    const customConfig = {
      ...makeConfig(tmpFile),
      corsOrigins: ["https://app.stellarcred.xyz"],
    };
    const customApp = buildApp(db, makeIngester(), customConfig);

    const res = await request(customApp)
      .get("/stats")
      .set("Origin", "https://evil.site");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("enforces rate limits and returns 429 + Retry-After when exceeded", async () => {
    const customConfig = {
      ...makeConfig(tmpFile),
      rateLimitMax: 3,
      rateLimitWindowMs: 60000,
      rateLimitEnabled: true,
    };
    const customApp = buildApp(db, makeIngester(), customConfig);

    for (let i = 1; i <= 3; i++) {
      const res = await request(customApp)
        .get("/stats")
        .set("X-Forwarded-For", "203.0.113.50");
      expect(res.status).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBe("3");
      expect(res.headers["ratelimit-remaining"]).toBe(String(3 - i));
    }

    const throttled = await request(customApp)
      .get("/stats")
      .set("X-Forwarded-For", "203.0.113.50");
    expect(throttled.status).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
    expect(throttled.body).toMatchObject({
      error: "too many requests",
      retryAfter: expect.any(Number),
    });

    const otherIpRes = await request(customApp)
      .get("/stats")
      .set("X-Forwarded-For", "203.0.113.99");
    expect(otherIpRes.status).toBe(200);
  });
});

// ── Response schema (#349) ───────────────────────────────────────────────────

describe("claim response schema", () => {
  it("normalizes a Postgres-shaped row (BIGINT columns as strings) to numbers", () => {
    const pgShapedRow = {
      id: "7",
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: "1700000000",
      expiry: "1999999999",
      ledger_sequence: "123456789",
      threshold: "50000",
      revoked: 0,
    } as unknown as ClaimRow;

    const serialized = serializeClaim(pgShapedRow);

    expect(serialized).toEqual({
      id: 7,
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1700000000,
      expiry: 1999999999,
      ledger_sequence: 123456789,
      threshold: 50000,
      revoked: 0,
    });
    for (const field of [
      "id",
      "verified_at",
      "expiry",
      "ledger_sequence",
      "threshold",
      "revoked",
    ] as const) {
      expect(typeof serialized[field]).toBe("number");
    }
  });

  it("passes a null threshold through as null, not 0 or NaN", () => {
    const row = {
      id: "1",
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: "1000",
      expiry: "9999999",
      ledger_sequence: "1",
      threshold: null,
      revoked: 0,
    } as unknown as ClaimRow;

    expect(serializeClaim(row).threshold).toBeNull();
  });

  it("produces identical output whether the row's numeric fields arrive as strings or numbers", () => {
    const numeric: ClaimRow = {
      id: 7,
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1700000000,
      expiry: 1999999999,
      ledger_sequence: 123456789,
      threshold: 50000,
      revoked: 0,
    };
    const stringified = {
      ...numeric,
      id: String(numeric.id),
      verified_at: String(numeric.verified_at),
      expiry: String(numeric.expiry),
      ledger_sequence: String(numeric.ledger_sequence),
      threshold: String(numeric.threshold),
    } as unknown as ClaimRow;

    expect(serializeClaim(stringified)).toEqual(serializeClaim(numeric));
  });

  it("GET /claims and GET /recent both return the exact documented key set — no leaked internal columns", async () => {
    (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 42,
      threshold: 500,
      revoked: 0,
    });

    const expectedKeys = [
      "id",
      "wallet",
      "credential_type",
      "issuer",
      "verified_at",
      "expiry",
      "ledger_sequence",
      "threshold",
      "revoked",
    ].sort();

    const claimsRes = await request(app).get("/claims?wallet=GALICE");
    expect(claimsRes.status).toBe(200);
    expect(claimsRes.body.claims).toHaveLength(1);
    expect(Object.keys(claimsRes.body.claims[0]).sort()).toEqual(expectedKeys);
    for (const field of ["id", "verified_at", "expiry", "ledger_sequence", "revoked"]) {
      expect(typeof claimsRes.body.claims[0][field]).toBe("number");
    }

    const recentRes = await request(app).get("/recent");
    expect(recentRes.status).toBe(200);
    expect(recentRes.body.claims).toHaveLength(1);
    expect(Object.keys(recentRes.body.claims[0]).sort()).toEqual(expectedKeys);
  });
});

// ── Authentication (API_KEY) ───────────────────────────────────────────────────
//
// When API_KEY is set, /claims, /stats, and /recent require a matching token.
// /health and /metrics are always public regardless of mode.

const TEST_KEY = "test-secret-key-abc123";

describe("authenticated mode (apiKey set)", () => {
  let authApp: Application;

  beforeEach(() => {
    authApp = buildApp(db, makeIngester(), {
      ...makeConfig(tmpFile),
      apiKey: TEST_KEY,
      rateLimitEnabled: false,
    });
  });

  // /health and /metrics are always public — probes must not need credentials.

  describe("GET /health", () => {
    it("returns 200 without credentials", async () => {
      const res = await request(authApp).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "ok" });
    });

    it("returns 200 even when a wrong token is supplied", async () => {
      const res = await request(authApp)
        .get("/health")
        .set("Authorization", "Bearer wrong-key");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /metrics", () => {
    it("returns 200 without credentials", async () => {
      const res = await request(authApp).get("/metrics");
      expect(res.status).toBe(200);
    });
  });

  // Each guarded endpoint: missing / wrong / valid token.

  describe("GET /claims", () => {
    it("returns 401 with no credentials", async () => {
      const res = await request(authApp).get("/claims?wallet=GALICE");
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/authentication required/i);
    });

    it("returns 401 with a wrong Bearer token", async () => {
      const res = await request(authApp)
        .get("/claims?wallet=GALICE")
        .set("Authorization", "Bearer wrong-key");
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid API key/i);
    });

    it("returns 401 with a wrong X-API-Key header", async () => {
      const res = await request(authApp)
        .get("/claims?wallet=GALICE")
        .set("X-API-Key", "wrong-key");
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid API key/i);
    });

    it("returns 401 for a malformed Authorization header (no scheme)", async () => {
      const res = await request(authApp)
        .get("/claims?wallet=GALICE")
        .set("Authorization", TEST_KEY);
      expect(res.status).toBe(401);
    });

    it("returns 401 for unsupported auth scheme (Basic)", async () => {
      const res = await request(authApp)
        .get("/claims?wallet=GALICE")
        .set("Authorization", `Basic ${Buffer.from("user:" + TEST_KEY).toString("base64")}`);
      expect(res.status).toBe(401);
    });

    it("returns 200 with correct Bearer token", async () => {
      const res = await request(authApp)
        .get("/claims?wallet=GALICE")
        .set("Authorization", `Bearer ${TEST_KEY}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ wallet: "GALICE", claims: [] });
    });

    it("returns 200 with correct X-API-Key header", async () => {
      const res = await request(authApp)
        .get("/claims?wallet=GALICE")
        .set("X-API-Key", TEST_KEY);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ wallet: "GALICE", claims: [] });
    });

    it("auth is checked before wallet param validation (no wallet → 401, not 400)", async () => {
      const res = await request(authApp).get("/claims");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /stats", () => {
    it("returns 401 with no credentials", async () => {
      const res = await request(authApp).get("/stats");
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/authentication required/i);
    });

    it("returns 401 with wrong token", async () => {
      const res = await request(authApp)
        .get("/stats")
        .set("X-API-Key", "nope");
      expect(res.status).toBe(401);
    });

    it("returns 200 with correct Bearer token", async () => {
      const res = await request(authApp)
        .get("/stats")
        .set("Authorization", `Bearer ${TEST_KEY}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ stats: [] });
    });

    it("returns 200 with correct X-API-Key header", async () => {
      const res = await request(authApp)
        .get("/stats")
        .set("X-API-Key", TEST_KEY);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /recent", () => {
    it("returns 401 with no credentials", async () => {
      const res = await request(authApp).get("/recent");
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/authentication required/i);
    });

    it("returns 401 with wrong token", async () => {
      const res = await request(authApp)
        .get("/recent")
        .set("Authorization", "Bearer totally-wrong");
      expect(res.status).toBe(401);
    });

    it("returns 200 with correct Bearer token", async () => {
      const res = await request(authApp)
        .get("/recent")
        .set("Authorization", `Bearer ${TEST_KEY}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ claims: [], limit: 20, nextCursor: null });
    });

    it("returns 200 with correct X-API-Key header", async () => {
      const res = await request(authApp)
        .get("/recent")
        .set("X-API-Key", TEST_KEY);
      expect(res.status).toBe(200);
    });
  });
});

describe("public mode (no apiKey)", () => {
  it("all claim endpoints are open without credentials", async () => {
    // Verify that the default app (no apiKey) accepts requests without any token
    const claims = await request(app).get("/claims?wallet=GUNKNOWN");
    expect(claims.status).toBe(200);

    const stats = await request(app).get("/stats");
    expect(stats.status).toBe(200);

    const recent = await request(app).get("/recent");
    expect(recent.status).toBe(200);
  });
});
