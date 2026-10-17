import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContractError, parseDecide, parseHistoryItem, parseProviders, parseSession } from "../src/parse";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function rawSession(patch: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    mode: "battle",
    scenarioId: "game",
    fen: START,
    sideToMove: "w",
    objective: "Vencer.",
    candidates: [{ id: "e2e4", san: "e4" }, "d2d4"],
    outcome: null,
    status: "ready",
    history: [],
    totals: { durationSumMs: 0, sessionClockMs: 10, jev: null, all: null },
    clock: { limitMs: 300000, remainingMs: [300000, 299000] },
    ...patch,
  };
}

describe("parseProviders", () => {
  it("mantém só provedores com id conhecido e normaliza modelos e motivo", () => {
    const parsed = parseProviders({
      providers: [
        { id: "demo", label: "Demo", kind: "demo", available: true, models: [{ id: " jev-demo ", label: "JEV" }, { id: "" }] },
        { id: "jev", kind: "api", available: false, models: [] },
        { id: "desconhecido", available: true, models: [] },
        "lixo",
      ],
    });
    assert.deepEqual(parsed.providers, [
      { id: "demo", label: "Demo", kind: "demo", available: true, reason: null, models: [{ id: "jev-demo", label: "JEV" }] },
      { id: "jev", label: "jev", kind: "api", available: false, reason: "indisponível", models: [] },
    ]);
  });

  it("recusa corpo sem lista de provedores", () => {
    assert.throws(() => parseProviders({}), ContractError);
    assert.throws(() => parseProviders(null), ContractError);
  });
});

describe("parseSession", () => {
  it("lê a sessão, aceita candidato como texto e usa o relógio dos totais", () => {
    const session = parseSession(rawSession());
    assert.equal(session.sessionId, "s1");
    assert.equal(session.mode, "battle");
    assert.deepEqual(session.candidates, [{ id: "e2e4", san: "e4" }, { id: "d2d4", san: "d2d4" }]);
    assert.equal(session.sessionClockMs, 10);
    assert.deepEqual(session.clock, { limitMs: 300000, remainingMs: [300000, 299000] });
    assert.equal(session.inCheck, null);
  });

  it("desembrulha { session: {...} } e aceita sideToMove por extenso", () => {
    const session = parseSession({ session: rawSession({ sideToMove: "black" }) });
    assert.equal(session.sideToMove, "b");
  });

  it("classifica o desfecho por marcador e preenche rótulo padrão", () => {
    assert.equal(parseSession(rawSession({ outcome: { kind: "checkmate", winnerSlot: 1, san: "Qxf7#" } })).outcome?.kind, "checkmate");
    assert.equal(parseSession(rawSession({ outcome: { kind: "draw", reason: "afogamento" } })).outcome?.label, "Empate. afogamento");
    assert.equal(parseSession(rawSession({ outcome: { kind: "timeout", winnerSlot: 0 } })).outcome?.label, "Vitória por tempo de Participante 1.");
    assert.deepEqual(parseSession(rawSession({ outcome: "Interrompida" })).outcome, {
      kind: "stopped",
      label: "Interrompida",
      winnerSlot: null,
      san: null,
      reason: null,
    });
  });

  it("recusa sessão sem campos obrigatórios", () => {
    assert.throws(() => parseSession(rawSession({ fen: "" })), ContractError);
    assert.throws(() => parseSession(rawSession({ mode: "x" })), ContractError);
    assert.throws(() => parseSession("texto"), ContractError);
  });
});

describe("parseHistoryItem", () => {
  it("normaliza números, ids de candidatos e campos ausentes", () => {
    const entry = parseHistoryItem(
      {
        slot: 1,
        provider: "openai",
        modelRequested: "gpt",
        choiceId: "e7e5",
        validation: "aceita",
        durationMs: "rápido",
        inputTokens: 12,
        costUsd: 0.001,
        costNature: "estimated",
        mode: "real",
        candidates: ["e7e5", { id: "d7d5" }, 3],
        distribution: { e7e5: 0.9, d7d5: "x" },
      },
      "s9",
    );
    assert.ok(entry);
    assert.equal(entry.sessionId, "s9");
    assert.equal(entry.durationMs, null);
    assert.equal(entry.inputTokens, 12);
    assert.deepEqual(entry.candidateIds, ["e7e5", "d7d5"]);
    assert.deepEqual(entry.distribution, { e7e5: 0.9 });
    assert.equal(entry.applied, null);
  });

  it("devolve null sem slot válido", () => {
    assert.equal(parseHistoryItem({ slot: 2 }), null);
    assert.equal(parseHistoryItem(null), null);
  });
});

describe("parseDecide", () => {
  const decision = { slot: 0, provider: "demo", modelRequested: "jev-demo", choiceId: "e2e4", validation: "aceita", durationMs: 5 };

  it("marca como obsoleta a resposta ignorada ou de outra sessão", () => {
    assert.deepEqual(parseDecide({ ignored: true }, "s1"), { stale: true });
    assert.deepEqual(parseDecide({ session: rawSession({ sessionId: "outra" }) }, "s1"), { stale: true });
  });

  it("anexa a decisão ao histórico quando o servidor não a incluiu", () => {
    const parsed = parseDecide({ session: rawSession(), decision }, "s1");
    assert.equal(parsed.stale, false);
    if (parsed.stale) return;
    assert.equal(parsed.blocked, false);
    assert.equal(parsed.session.history.length, 1);
    assert.equal(parsed.decision?.sessionId, "s1");
  });

  it("não duplica a decisão já presente no histórico", () => {
    const parsed = parseDecide({ session: rawSession({ history: [decision] }), decision }, "s1");
    if (parsed.stale) assert.fail("não deveria ser obsoleta");
    assert.equal(parsed.session.history.length, 1);
  });

  it("sem decisão é bloqueada e carrega o motivo", () => {
    const parsed = parseDecide({ session: rawSession(), decision: null, blocked: true, reason: "pausada" }, "s1");
    if (parsed.stale) assert.fail("não deveria ser obsoleta");
    assert.equal(parsed.blocked, true);
    assert.equal(parsed.reason, "pausada");
  });
});
