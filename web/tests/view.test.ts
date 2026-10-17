import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlacement, uciSquares } from "../src/fen";
import { defaultParticipants, quickMatchups, reconcileParticipants } from "../src/matchups";
import type { HistoryEntry, ProviderInfo, SessionSnapshot } from "../src/types";
import { costNote, displayMove, isJevEntry, isSimulated, lastAppliedChoice, latestFor, victoryLine } from "../src/view";

function entry(patch: Partial<HistoryEntry>): HistoryEntry {
  return {
    sessionId: "s",
    slot: 0,
    choiceId: null,
    san: null,
    validation: null,
    failureReason: null,
    modelRequested: "m",
    modelReturned: null,
    provider: null,
    durationMs: null,
    sdkDurationMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: null,
    mode: null,
    confidence: null,
    distribution: null,
    fen: null,
    candidateIds: null,
    applied: null,
    logical: null,
    ...patch,
  };
}

const demo: ProviderInfo = {
  id: "demo",
  label: "Demo",
  kind: "demo",
  available: true,
  reason: null,
  models: [
    { id: "jev-demo", label: "JEV · simulado" },
    { id: "rival-greedy", label: "Rival guloso · simulado" },
    { id: "rival-random", label: "Rival aleatório · simulado" },
  ],
};
const jev: ProviderInfo = { id: "jev", label: "JEV", kind: "api", available: true, reason: null, models: [{ id: "jev-latest", label: "JEV" }] };
const cli: ProviderInfo = { id: "cli", label: "CLI", kind: "cli", available: false, reason: "sem config", models: [] };

describe("fen", () => {
  it("lê a colocação das peças e recusa FEN inválido", () => {
    const rows = parsePlacement("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
    assert.ok(rows);
    assert.equal(rows[4]?.[4], "P");
    assert.equal(rows[6]?.[4], null);
    assert.equal(parsePlacement("8/8/8"), null);
    assert.equal(parsePlacement("9/8/8/8/8/8/8/8 w - - 0 1"), null);
    assert.equal(parsePlacement("x7/8/8/8/8/8/8/8 w - - 0 1"), null);
  });

  it("extrai casas de origem e destino de um UCI", () => {
    assert.deepEqual(uciSquares("E7E8q"), { from: "e7", to: "e8" });
    assert.equal(uciSquares("e9e8"), null);
    assert.equal(uciSquares("e2"), null);
    assert.equal(uciSquares(null), null);
  });
});

describe("view", () => {
  it("acha a última entrada por slot e o último lance aplicado", () => {
    const history = [
      entry({ slot: 0, choiceId: "e2e4", validation: "aceita", applied: true }),
      entry({ slot: 1, choiceId: "zz", validation: "recusada" }),
      entry({ slot: 0, choiceId: "d2d4", validation: "aceita", applied: false }),
    ];
    assert.equal(latestFor(history, 1)?.choiceId, "zz");
    assert.equal(latestFor([], 0), null);
    assert.equal(lastAppliedChoice(history), "e2e4");
  });

  it("mostra SAN quando houver, senão procura nos candidatos da mesma posição", () => {
    const session = { mode: "battle", fen: "f", candidates: [{ id: "e2e4", san: "e4" }] } as SessionSnapshot;
    assert.equal(displayMove(null, session), "Sem chamada.");
    assert.equal(displayMove(entry({ san: "Nf3" }), session), "Nf3");
    assert.equal(displayMove(entry({ choiceId: "e2e4", fen: "f" }), session), "e4");
    assert.equal(displayMove(entry({ choiceId: "e2e4", fen: "outra" }), session), "e2e4");
  });

  it("simulado e JEV por entrada ou participante", () => {
    const participants = [{ slot: 0 as const, provider: "demo" as const, modelId: "jev-demo" }];
    assert.equal(isSimulated(entry({ mode: "demo" })), true);
    assert.equal(isSimulated(null, participants[0]), true);
    assert.equal(isSimulated(entry({ mode: "real", provider: "jev" })), false);
    assert.equal(isJevEntry(entry({ slot: 0, modelRequested: "jev-demo" }), participants), true);
    assert.equal(isJevEntry(entry({ slot: 0, provider: "cli", modelRequested: "x" }), participants), false);
  });

  it("nota de custo e linha de vitória", () => {
    assert.equal(costNote(entry({ costNature: "included" }), "cursor"), "Custo incluso no plano. Fora da soma em dólar.");
    assert.equal(costNote(entry({ costNature: "unavailable" }), "cursor"), "Custo indisponível no Cursor.");
    assert.equal(costNote(entry({ costUsd: 0.1, costNature: "estimated", mode: "demo" }), "demo"), "Custo simulado: tarifa ilustrativa, não é fatura.");
    assert.equal(costNote(entry({ costUsd: 0.1, costNature: "reported" }), "cli"), null);
    const labels = new Map([["jev-demo", "JEV · simulado"]]);
    const participants = [{ slot: 1 as const, provider: "demo" as const, modelId: "jev-demo" }];
    assert.equal(victoryLine({ kind: "checkmate", label: "", winnerSlot: 1, san: null, reason: null }, participants, labels), "Vitória de JEV · simulado");
    assert.equal(victoryLine({ kind: "draw", label: "", winnerSlot: null, san: null, reason: null }, participants, labels), null);
  });
});

describe("matchups", () => {
  it("padrão: JEV real se houver, senão o simulado, contra o rival guloso", () => {
    assert.deepEqual(defaultParticipants([demo]), [
      { slot: 0, provider: "demo", modelId: "jev-demo" },
      { slot: 1, provider: "demo", modelId: "rival-greedy" },
    ]);
    assert.deepEqual(defaultParticipants([demo, jev])[0], { slot: 0, provider: "jev", modelId: "jev-latest" });
    assert.deepEqual(defaultParticipants([cli]), [
      { slot: 0, provider: "demo", modelId: "" },
      { slot: 1, provider: "demo", modelId: "" },
    ]);
  });

  it("mantém a escolha que ainda existe e troca a que sumiu", () => {
    const current = [
      { slot: 0 as const, provider: "demo" as const, modelId: "rival-random" },
      { slot: 1 as const, provider: "jev" as const, modelId: "jev-latest" },
    ];
    assert.deepEqual(reconcileParticipants(current, [demo]), [
      { slot: 0, provider: "demo", modelId: "rival-random" },
      { slot: 1, provider: "demo", modelId: "rival-greedy" },
    ]);
  });

  it("confrontos rápidos: âncora contra cada demo, sem repetir a âncora e com sufixo limpo", () => {
    const labels = quickMatchups([demo]).map((item) => item.label);
    assert.deepEqual(labels, ["JEV · simulado × Rival guloso", "JEV · simulado × Rival aleatório"]);
    const withJev = quickMatchups([demo, jev]);
    assert.equal(withJev[0]?.label, "JEV × JEV · simulado");
    assert.equal(withJev.length, 3);
    assert.deepEqual(quickMatchups([cli]), []);
  });
});
