import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyUci, hasMatingMaterial, inspect, matingMoves } from "../src/engine.js";
import { CHECK_OBJECTIVE_MANY, CHECK_OBJECTIVE_SINGLE, DRAW_KINGS_FEN, GAME_OBJECTIVE, objectiveFor, SCENARIOS, START_FEN } from "../src/scenarios.js";

describe("motor", () => {
  it("a partida começa na posição inicial e o objetivo pede o lance mais forte", () => {
    assert.equal(SCENARIOS.game.fen, START_FEN);
    assert.equal(objectiveFor("game", inspect(START_FEN).candidates.length), GAME_OBJECTIVE);
    assert.equal(inspect(START_FEN).terminal, null);
    assert.equal(inspect(START_FEN).sideToMove, "w");
  });

  it("material de mate: peão, torre, dama ou duas peças menores", () => {
    assert.equal(hasMatingMaterial("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "w"), false);
    assert.equal(hasMatingMaterial("4k3/8/8/8/8/8/8/3NK3 w - - 0 1", "w"), false);
    assert.equal(hasMatingMaterial("4k3/8/8/8/8/8/8/2BNK3 w - - 0 1", "w"), true);
    assert.equal(hasMatingMaterial("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "w"), true);
    assert.equal(hasMatingMaterial("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "b"), false);
    assert.equal(hasMatingMaterial("r3k3/8/8/8/8/8/8/4K3 w - - 0 1", "b"), true);
  });

  it("carrega os cenários e separa UCI de SAN", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      const view = inspect(scenario.fen);
      assert.equal(view.fen, scenario.fen);
      assert.ok(view.candidates.length > 0);
      for (const candidate of view.candidates) {
        assert.match(candidate.id, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
        assert.notEqual(candidate.san, candidate.id);
      }
    }
  });

  it("cada promoção é um candidato", () => {
    const view = inspect("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    const promotions = view.candidates.filter((candidate) => candidate.id.length === 5);
    assert.deepEqual(
      promotions.map((candidate) => candidate.id).sort(),
      ["a7a8b", "a7a8n", "a7a8q", "a7a8r"],
    );
  });

  it("conjunto de mates de mate é o que o motor classifica", () => {
    const mates = matingMoves(SCENARIOS.mate.fen);
    assert.deepEqual(
      mates.map((candidate) => candidate.id),
      ["h5f7"],
    );
    assert.equal(mates[0]?.san, "Qxf7#");
    for (const mate of mates) {
      assert.equal(applyUci(SCENARIOS.mate.fen, mate.id).checkmate, true);
    }
    const legal = inspect(SCENARIOS.mate.fen).candidates;
    const quiet = legal.find((candidate) => !mates.some((mate) => mate.id === candidate.id));
    assert.ok(quiet);
    assert.equal(applyUci(SCENARIOS.mate.fen, quiet.id).checkmate, false);
  });

  it("check tem um lance legal e o objetivo muda só quando há mais de um", () => {
    const view = inspect(SCENARIOS.check.fen);
    assert.equal(view.inCheck, true);
    assert.equal(view.candidates.length, 1);
    assert.equal(view.candidates[0]?.id, "a1b1");
    assert.equal(objectiveFor("check", view.candidates.length), CHECK_OBJECTIVE_SINGLE);
    assert.equal(objectiveFor("check", 2), CHECK_OBJECTIVE_MANY);
    assert.equal(objectiveFor("opening", 20), SCENARIOS.opening.objective);
  });

  it("reis sozinhos são empate imediato por material insuficiente", () => {
    const fen = DRAW_KINGS_FEN;
    assert.equal(fen, "8/8/8/8/8/4k3/8/4K3 w - - 0 1");
    const view = inspect(fen);
    assert.equal(view.terminal?.kind, "draw");
    assert.equal(view.terminal && "reason" in view.terminal ? view.terminal.reason : "", "material insuficiente");
    assert.ok(view.candidates.length > 0);
  });
});
