import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cursorCost, isJevEntry, jevCost, sumCosts, totalsFor } from "../src/cost.js";
import type { HistoryEntry } from "../src/types.js";
import { exportHasSecret, sanitize } from "../src/sanitize.js";

describe("custo", () => {
  it("estima só a entrada do Jev e não trata ausência como zero", () => {
    assert.deepEqual(jevCost(1_000_000), { costUsd: 0.042, costNature: "estimated" });
    assert.deepEqual(jevCost(null), { costUsd: null, costNature: "unavailable" });
    assert.deepEqual(jevCost(0), { costUsd: 0, costNature: "estimated" });
  });

  it("classifica o custo do Cursor sem somar incluso como US$ 0", () => {
    assert.deepEqual(cursorCost(undefined), { costUsd: null, costNature: "unavailable" });
    assert.deepEqual(cursorCost({}), { costUsd: null, costNature: "unavailable" });
    assert.deepEqual(cursorCost({ chargedCents: 0 }), { costUsd: null, costNature: "included" });
    assert.deepEqual(cursorCost({ chargedCents: 250 }), { costUsd: 2.5, costNature: "reported" });
    const mixed = sumCosts([
      { costUsd: 0.042, costNature: "estimated" },
      { costUsd: null, costNature: "unavailable" },
    ]);
    assert.equal(mixed.costUsd, 0.042);
    assert.equal(mixed.availability, "partial");
    assert.equal(mixed.unavailableCount, 1);
    const included = sumCosts([
      { costUsd: 0.042, costNature: "estimated" },
      { costUsd: null, costNature: "included" },
    ]);
    assert.equal(included.costUsd, 0.042);
    assert.equal(included.includedCount, 1);
    assert.equal(included.availability, "known");
    const none = sumCosts([{ costUsd: null, costNature: "unavailable" }]);
    assert.equal(none.costUsd, null);
    assert.equal(none.availability, "unavailable");
    const plan = sumCosts([{ costUsd: null, costNature: "included" }]);
    assert.equal(plan.costUsd, null);
    assert.equal(plan.availability, "included");
  });
});

describe("custo JEV", () => {
  function entry(provider: HistoryEntry["provider"], modelRequested: string): HistoryEntry {
    return { provider, modelRequested, costUsd: 0.01, costNature: "estimated", durationMs: 10 } as HistoryEntry;
  }

  it("conta como JEV o provedor jev e o jev-demo do provedor demo, e só eles", () => {
    assert.equal(isJevEntry(entry("jev", "jev-latest")), true);
    assert.equal(isJevEntry(entry("demo", "jev-demo")), true);
    assert.equal(isJevEntry(entry("demo", "rival-greedy")), false);
    assert.equal(isJevEntry(entry("cursor", "jev-demo")), false);
    const totals = totalsFor([entry("demo", "jev-demo"), entry("demo", "rival-greedy"), entry("demo", "jev-demo")], 0, 1000);
    assert.equal(totals.jev.costUsd, 0.02);
    assert.equal(totals.jev.availability, "known");
    assert.equal(totals.all.costUsd, 0.03);
  });
});

describe("exportação", () => {
  it("remove Authorization e o segredo", () => {
    const clean = sanitize({
      note: "Authorization: Bearer super-secret-value",
      Authorization: "Bearer super-secret-value",
      nested: { apiKey: "super-secret-value", inputTokens: 3 },
    });
    assert.equal(exportHasSecret(clean), false);
    assert.equal(JSON.stringify(clean).includes("super-secret-value"), false);
    assert.equal((clean as { nested: { inputTokens: number } }).nested.inputTokens, 3);
  });
});
