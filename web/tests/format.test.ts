import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatClock,
  formatCost,
  formatCostTotal,
  formatDuration,
  formatUsd,
  moveLabel,
  providerLabel,
  summarizeCost,
  summarizeDurations,
  summarizeNumbers,
  UNAVAILABLE,
} from "../src/format";

describe("format", () => {
  it("duração e relógio em pt-BR; ausente vira Indisponível", () => {
    assert.equal(formatDuration(1234), "1,23 s");
    assert.equal(formatDuration(null), UNAVAILABLE);
    assert.equal(formatClock(61000), "1:01");
    assert.equal(formatClock(-5), "0:00");
    assert.equal(formatClock(undefined), UNAVAILABLE);
  });

  it("custo pequeno mostra mais casas; natureza vira sufixo", () => {
    assert.match(formatUsd(0.000123), /0,000123/);
    assert.match(formatUsd(1.5), /1,50/);
    assert.match(formatCost(0.02, "estimated"), /estimativa$/);
    assert.match(formatCost(0.02, "reported"), /reportado$/);
    assert.equal(formatCost(null, "unavailable", "cursor"), "Indisponível no Cursor");
    assert.equal(formatCost(null, "included"), "Incluso no plano");
  });

  it("total de custo distingue conhecido, parcial, incluso e indisponível", () => {
    assert.equal(formatCostTotal({ costUsd: null, availability: "unavailable", unavailableCount: 2, includedCount: 0 }), "Total indisponível");
    assert.equal(formatCostTotal({ costUsd: 1, availability: "included", unavailableCount: 0, includedCount: 1 }), "Incluso no plano");
    assert.match(formatCostTotal({ costUsd: 1, availability: "partial", unavailableCount: 1, includedCount: 0 }), /parcial\. 1 indisponível\.$/);
    assert.doesNotMatch(formatCostTotal({ costUsd: 1, availability: "known", unavailableCount: 0, includedCount: 0 }), /parcial/);
  });

  it("soma custos conhecidos e anota os que faltam", () => {
    assert.equal(summarizeCost([]).text, "Sem chamada.");
    assert.equal(summarizeCost([{ costUsd: null, costNature: "unavailable", provider: "cli" }]).text, "Total indisponível");
    const mixed = summarizeCost([
      { costUsd: 0.5, costNature: "reported", provider: "cli" },
      { costUsd: 0.25, costNature: "estimated", provider: "openai" },
      { costUsd: null, costNature: "unavailable", provider: "cli" },
      { costUsd: null, costNature: "included", provider: "cursor" },
    ]).text;
    assert.match(mixed, /0,75/);
    assert.match(mixed, /1 indisponível/);
    assert.match(mixed, /1 inclusa no plano/);
  });

  it("soma números e durações com nota de parcial", () => {
    assert.equal(summarizeNumbers([], "vazio"), "vazio");
    assert.equal(summarizeNumbers([null]), UNAVAILABLE);
    assert.equal(summarizeNumbers([1000, 234]), "1.234");
    assert.equal(summarizeNumbers([3, null]), "3. Parcial. 1 indisponível.");
    assert.equal(summarizeDurations([500, 500]), "1,00 s");
    assert.equal(summarizeDurations([500, null, null]), "0,50 s. Parcial. 2 indisponíveis.");
  });

  it("rótulos de provedor e lance", () => {
    assert.equal(providerLabel("openai"), "API compatível com OpenAI");
    assert.equal(providerLabel(null), UNAVAILABLE);
    assert.equal(moveLabel(null), "Sem chamada.");
    assert.equal(moveLabel({ san: null, choiceId: "e2e4" }), "e2e4");
    assert.equal(moveLabel({ san: "e4", choiceId: "e2e4" }), "e4");
  });
});
