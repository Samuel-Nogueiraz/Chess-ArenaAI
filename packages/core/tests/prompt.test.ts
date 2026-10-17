import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCorrection, buildMovePrompt, buildStandalonePrompt, looseMoveToken, MOVE_SYSTEM_PROMPT, parseMoveId } from "../src/prompt.js";
import { inspect } from "../src/engine.js";
import { SCENARIOS } from "../src/scenarios.js";
import type { DecisionContext } from "../src/types.js";

function contextFor(fen: string): DecisionContext {
  const view = inspect(fen);
  return { sessionId: "s", fen: view.fen, sideToMove: view.sideToMove, objective: "Vencer.", candidates: view.candidates };
}

const candidates = [
  { id: "e2e4", san: "e4" },
  { id: "d2d4", san: "d4" },
  { id: "e7e8q", san: "e8=Q" },
];

describe("prompt", () => {
  it("parseMoveId aceita a resposta exata, com pontuação, aspas e marcadores do modelo", () => {
    assert.equal(parseMoveId("e2e4", candidates), "e2e4");
    assert.equal(parseMoveId("  e2e4\n", candidates), "e2e4");
    assert.equal(parseMoveId('"d2d4".', candidates), "d2d4");
    assert.equal(parseMoveId("E2E4", candidates), "e2e4");
    assert.equal(parseMoveId("e2e4<|eos|>", candidates), "e2e4");
    assert.equal(parseMoveId("e7e8q", candidates), "e7e8q");
    assert.equal(parseMoveId("e2e4", ["e2e4", "d2d4"]), "e2e4");
  });

  it("parseMoveId acha o primeiro token UCI que está na lista dentro de texto livre", () => {
    assert.equal(parseMoveId("Eu escolho e2e4 porque abre o centro.", candidates), "e2e4");
    assert.equal(parseMoveId("Not a1a1, play d2d4 or e2e4", candidates), "d2d4");
    assert.equal(parseMoveId("**Move:** `e2e4`", candidates), "e2e4");
    assert.equal(parseMoveId("best is e7e8q!", candidates), "e7e8q");
  });

  it("parseMoveId recusa lance ilegal, vazio e token colado em outra palavra", () => {
    assert.equal(parseMoveId("e2e5", candidates), null);
    assert.equal(parseMoveId("d2d5 e9e9", candidates), null);
    assert.equal(parseMoveId("", candidates), null);
    assert.equal(parseMoveId("   ", candidates), null);
    assert.equal(parseMoveId("não sei", candidates), null);
    assert.equal(parseMoveId("xe2e4x", candidates), null);
    assert.equal(parseMoveId("e2e4", []), null);
  });

  it("looseMoveToken devolve o primeiro token com formato UCI, legal ou não", () => {
    assert.equal(looseMoveToken("jogue e9e9? não: a1a1"), "a1a1");
    assert.equal(looseMoveToken("sem lance"), null);
  });

  it("o pedido leva a posição, a lista de ids e a regra de responder só com um id", () => {
    const context = contextFor(SCENARIOS.opening.fen);
    const prompt = buildMovePrompt(context);
    assert.match(prompt, /legal_moves: /);
    assert.match(prompt, /e2e4 e4/);
    assert.match(prompt, /ids: a2a3, /);
    assert.ok(prompt.includes(`FEN: ${SCENARIOS.opening.fen}`));
    assert.match(prompt, /Reply with only one of these ids/);
    assert.doesNotMatch(prompt, /not a coding assistant/);
    assert.match(MOVE_SYSTEM_PROMPT, /not a coding assistant/);
    assert.equal(buildStandalonePrompt(context).startsWith(MOVE_SYSTEM_PROMPT), true);
    assert.match(buildMovePrompt({ ...context, lastMove: { id: "e7e5", san: "e5" } }), /Opponent played e7e5 \(e5\)\./);
  });

  it("a correção é autossuficiente e cita a resposta recusada", () => {
    const context = contextFor(SCENARIOS.opening.fen);
    const correction = buildCorrection(context, "e2e5");
    assert.match(correction, /"e2e5" is not in legal_moves/);
    assert.match(correction, /You play white\./);
    assert.match(correction, /legal_moves: a2a3 a3/);
    assert.match(correction, /FEN: /);
    assert.match(buildCorrection(context, ""), /not a move id/);
    assert.match(buildCorrection({ ...context, sideToMove: "b" }, "x"), /You play black\./);
  });
});
