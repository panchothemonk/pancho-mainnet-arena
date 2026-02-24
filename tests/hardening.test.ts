import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT_DIR = process.cwd();
let tempDir = "";

type SimEntry = {
  id: string;
  roundId: string;
  market: string;
  feedId: string;
  roundStartMs: number;
  roundEndMs: number;
  wallet: string;
  direction: "UP" | "DOWN";
  stakeBucks: number;
  joinedAtMs: number;
};

const FEED_BY_MARKET: Record<string, string> = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
};

const mutableEnv = process.env as Record<string, string | undefined>;

function installOracleMock() {
  const originalFetch = globalThis.fetch;
  const baseByFeed: Record<string, number> = {
    [FEED_BY_MARKET.SOL]: 100_000,
    [FEED_BY_MARKET.BTC]: 6_000_000,
    [FEED_BY_MARKET.ETH]: 350_000
  };

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const _ = init;
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const feedId = url.searchParams.get("ids[]") ?? FEED_BY_MARKET.SOL;
    const timestampMatch = url.pathname.match(/\/price\/(\d+)$/);
    const ts = timestampMatch ? Number(timestampMatch[1]) : Math.floor(Date.now() / 1000);
    const base = baseByFeed[feedId] ?? 100_000;
    const rawPrice = base + (ts % 5_000);
    const payload = {
      parsed: [
        {
          price: {
            price: String(rawPrice),
            conf: "100",
            expo: -2,
            publish_time: ts
          }
        }
      ]
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("production on-chain mode disables legacy /api/entries", async () => {
  const prevNodeEnv = mutableEnv.NODE_ENV;
  const prevOnchainMode = mutableEnv.NEXT_PUBLIC_USE_ONCHAIN_PROGRAM;
  mutableEnv.NODE_ENV = "production";
  mutableEnv.NEXT_PUBLIC_USE_ONCHAIN_PROGRAM = "true";

  try {
    const mod = await import("../app/api/entries/route");
    const req = new Request("http://localhost:3000/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invalid: true })
    });
    const res = await mod.POST(req);
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.match(String(body?.error ?? ""), /Legacy ledger registration is disabled/i);
  } finally {
    mutableEnv.NODE_ENV = prevNodeEnv;
    mutableEnv.NEXT_PUBLIC_USE_ONCHAIN_PROGRAM = prevOnchainMode;
  }
});

test("on-chain source enforces claimed/total position guard before dust sweep", async () => {
  const source = await readFile(path.join(ROOT_DIR, "onchain/programs/pancho_pvp/src/lib.rs"), "utf8");
  assert.match(source, /round\.total_positions[\s\S]*checked_add\(1\)/);
  assert.match(source, /round\.claimed_positions[\s\S]*checked_add\(1\)/);
  assert.match(source, /round\.claimed_positions == round\.total_positions/);
  assert.match(source, /PanchoError::ClaimsNotComplete/);
});

test("randomized settlement invariants: conservation holds and refunds are fee-free", async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "pancho-hardening-"));
  process.chdir(tempDir);
  mutableEnv.SIM_LEDGER_USE_D1 = "off";
  mutableEnv.SIM_LEDGER_SQLITE = "on";
  delete mutableEnv.DATABASE_URL;

  const restoreFetch = installOracleMock();
  try {
    const simLedger = await import("../lib/sim-ledger");
    const simSettlement = await import("../lib/sim-settlement");

    const nowMs = Date.now();
    const markets = ["SOL", "BTC", "ETH"] as const;
    const tiers = [5, 10, 25, 50, 100, 250];
    const roundIds: string[] = [];
    const entriesByRound = new Map<string, SimEntry[]>();

    let seq = 0;
    for (let i = 0; i < 30; i += 1) {
      const market = markets[i % markets.length];
      const roundStartMs = nowMs - (i + 6) * 120_000;
      const roundEndMs = roundStartMs + 360_000;
      const roundId = `${market}-${Math.floor(roundStartMs / 1000)}-5m`;
      roundIds.push(roundId);
      const entries: SimEntry[] = [];
      const participants = 2 + (i % 7);

      for (let p = 0; p < participants; p += 1) {
        const direction = p % 2 === 0 ? "UP" : "DOWN";
        const stakeBucks = tiers[(seq + p) % tiers.length];
        const entry: SimEntry = {
          id: `e-${i}-${p}-${seq}`,
          roundId,
          market,
          feedId: FEED_BY_MARKET[market],
          roundStartMs,
          roundEndMs,
          wallet: `wallet-${(seq + p) % 1000}`,
          direction,
          stakeBucks,
          joinedAtMs: roundStartMs + 10_000 + p
        };
        entries.push(entry);
        const added = await simLedger.addSimEntry(entry);
        assert.equal(added.created, true);
      }

      entriesByRound.set(roundId, entries);
      seq += 1;
    }

    for (const roundId of roundIds) {
      const settlement = await simSettlement.settleSimRoundOnce(roundId);
      assert.ok(settlement, `missing settlement for ${roundId}`);
      const entries = entriesByRound.get(roundId) ?? [];
      const totalCents = entries.reduce((sum, entry) => sum + Math.round(entry.stakeBucks * 100), 0);
      const paidCents = [...settlement.payoutsByEntryId.values()].reduce((sum, value) => sum + value, 0);

      assert.equal(
        paidCents + settlement.feeCents,
        totalCents,
        `conservation failed for ${roundId}: paid+fee != total`
      );

      if (settlement.settlement.mode === "REFUND") {
        assert.equal(settlement.feeCents, 0, `refund round charged fee for ${roundId}`);
      }
    }
  } finally {
    restoreFetch();
    process.chdir(ROOT_DIR);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  }
});

test("limited backfill converges all due rounds to settled state", async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "pancho-backfill-"));
  process.chdir(tempDir);
  mutableEnv.SIM_LEDGER_USE_D1 = "off";
  mutableEnv.SIM_LEDGER_SQLITE = "on";
  delete mutableEnv.DATABASE_URL;

  const restoreFetch = installOracleMock();
  try {
    const simLedger = await import("../lib/sim-ledger");
    const simSettlement = await import("../lib/sim-settlement");

    const nowMs = Date.now();
    const roundIds: string[] = [];
    for (let i = 0; i < 18; i += 1) {
      const market = i % 3 === 0 ? "SOL" : i % 3 === 1 ? "BTC" : "ETH";
      const roundStartMs = nowMs - (i + 5) * 120_000;
      const roundEndMs = roundStartMs + 360_000;
      const roundId = `${market}-${Math.floor(roundStartMs / 1000)}-5m`;
      roundIds.push(roundId);

      for (let p = 0; p < 4; p += 1) {
        await simLedger.addSimEntry({
          id: `bf-${i}-${p}`,
          roundId,
          market,
          feedId: FEED_BY_MARKET[market],
          roundStartMs,
          roundEndMs,
          wallet: `bf-wallet-${p}`,
          direction: p % 2 === 0 ? "UP" : "DOWN",
          stakeBucks: p % 2 === 0 ? 25 : 10,
          joinedAtMs: roundStartMs + 20_000 + p
        });
      }
    }

    let unsettled = roundIds.length;
    for (let iter = 0; iter < 20 && unsettled > 0; iter += 1) {
      await simSettlement.settleDueSimRounds(3);
      const statuses = await Promise.all(roundIds.map((roundId) => simLedger.readSimRoundSettlement(roundId)));
      unsettled = statuses.filter((item) => !item).length;
    }

    assert.equal(unsettled, 0, "not all due rounds settled via limited backfill");
  } finally {
    restoreFetch();
    process.chdir(ROOT_DIR);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  }
});
