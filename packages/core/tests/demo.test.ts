import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDemoAdapter, createRng, DEMO_MODELS, plyOf } from "../src/demo.js";
import { jevCost } from "../src/cost.js";
import { inspect } from "../src/engine.js";
import { buildMovePrompt } from "../src/prompt.js";
import { SCENARIOS } from "../src/scenarios.js";
import { createSessionStore } from "../src/session.js";
import type { AdapterRequest, DecisionContext, Slot } from "../src/types.js";

function requestFor(fen: string, modelId: string, options: { sessionId?: string; slot?: Slot; budgetMs?: number | null } = {}): AdapterRequest {
  const view = inspect(fen);
  const context: DecisionContext = {
    sessionId: options.sessionId ?? "sessao-demo",
    fen: view.fen,
    sideToMove: view.sideToMove,
    objective: "Vencer.",
    candidates: view.candidates,
  };
  const slot = options.slot ?? (view.sideToMove === "w" ? 0 : 1);
  return {
    sessionId: context.sessionId,
    slot,
    participant: { slot, provider: "demo", modelId },
    context,
    budgetMs: options.budgetMs ?? null,
  };
}

describe("provedor demo", () => {
  it("expõe os três modelos com rótulos para a interface", () => {
    assert.deepEqual(DEMO_MODELS.map((model) => model.id), ["jev-demo", "rival-greedy", "rival-random"]);
    assert.deepEqual(DEMO_MODELS.map((model) => model.label), ["JEV · simulado", "Rival guloso · simulado", "Rival aleatório · simulado"]);
  });

  it("é determinístico: mesma semente, mesma decisão, mesmos tokens e custo", async () => {
    const adapter = createDemoAdapter({ speed: 0 });
    for (const model of ["jev-demo", "rival-greedy", "rival-random"]) {
      const request = requestFor(SCENARIOS.opening.fen, model);
      const a = await adapter.decide(request);
      const b = await createDemoAdapter({ speed: 0 }).decide(request);
      assert.equal(a.choiceId, b.choiceId, model);
      assert.equal(a.inputTokens, b.inputTokens);
      assert.equal(a.outputTokens, b.outputTokens);
      assert.equal(a.costUsd, b.costUsd);
      assert.ok(a.choiceId);
    }
    const seeds = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const decision = await adapter.decide(requestFor(SCENARIOS.opening.fen, "rival-random", { sessionId: `s${index}` }));
      seeds.add(decision.choiceId ?? "");
    }
    assert.ok(seeds.size > 1, "a semente muda com a sessão");
  });

  it("o PRNG e o meio-lance saem do que o contexto já tem", () => {
    const a = createRng("x:1:0");
    const b = createRng("x:1:0");
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
    assert.notEqual(createRng("x:1:0")(), createRng("x:2:0")());
    assert.equal(plyOf(SCENARIOS.opening.fen), 0);
    assert.equal(plyOf("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"), 1);
    assert.equal(plyOf("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"), 2);
  });

  it("jev-demo acha o mate em um", async () => {
    const adapter = createDemoAdapter({ speed: 0 });
    for (const sessionId of ["a", "b", "c"]) {
      const decision = await adapter.decide(requestFor(SCENARIOS.mate.fen, "jev-demo", { sessionId }));
      assert.equal(decision.choiceId, "h5f7");
      assert.equal(decision.failureReason, null);
      assert.equal(decision.modelReturned, "jev-demo");
    }
  });

  it("rival-greedy captura a peça mais valiosa", async () => {
    const adapter = createDemoAdapter({ speed: 0 });
    // Torre em d1 pode tomar a dama em d5 ou o peão em d7... a dama vale mais.
    const fen = "4k3/3p4/8/3q4/8/8/8/3RK3 w - - 0 1";
    for (const sessionId of ["a", "b", "c", "d"]) {
      const decision = await adapter.decide(requestFor(fen, "rival-greedy", { sessionId }));
      assert.equal(decision.choiceId, "d1d5");
    }
  });

  it("só devolve lances legais, inclusive em partida inteira pelo repositório de sessões", async () => {
    const store = createSessionStore(createDemoAdapter({ speed: 0 }));
    const created = store.create({
      mode: "battle",
      scenarioId: "game",
      participants: [
        { slot: 0, provider: "demo", modelId: "jev-demo" },
        { slot: 1, provider: "demo", modelId: "rival-random" },
      ],
    });
    let plies = 0;
    while (plies < 24) {
      const session = store.get(created.sessionId);
      if (session.outcome) break;
      const result = await store.decide(created.sessionId, session.sideToMove === "w" ? 0 : 1);
      assert.equal(result.decision?.validation, "aceita", `lance ${plies + 1}`);
      assert.equal(result.decision?.mode, "demo");
      assert.equal(result.applied, true);
      plies += 1;
    }
    assert.ok(plies >= 1);
    const history = store.get(created.sessionId).history;
    assert.ok(history.every((entry) => entry.mode === "demo" && entry.costNature === "estimated"));
  });

  it("tokens e custo seguem o prompt e a tarifa ilustrativa, sempre como estimado", async () => {
    const adapter = createDemoAdapter({ speed: 0 });
    const request = requestFor(SCENARIOS.opening.fen, "jev-demo");
    const decision = await adapter.decide(request);
    const prompt = buildMovePrompt(request.context);
    assert.equal(decision.prompt, prompt);
    assert.equal(decision.inputTokens, Math.ceil(prompt.length / 4));
    assert.ok((decision.outputTokens ?? 0) >= 2 && (decision.outputTokens ?? 0) <= 6);
    assert.equal(decision.costNature, "estimated");
    assert.equal(decision.costUsd, jevCost(decision.inputTokens).costUsd);
    const rival = await adapter.decide(requestFor(SCENARIOS.opening.fen, "rival-greedy"));
    assert.equal(rival.costNature, "estimated");
    assert.ok((rival.costUsd ?? 0) > 0);
  });

  it("a latência é real e escala com speed", async () => {
    const fast = createDemoAdapter({ speed: 0.1 });
    const started = performance.now();
    const decision = await fast.decide(requestFor(SCENARIOS.opening.fen, "jev-demo"));
    const elapsed = performance.now() - started;
    // jev-demo: 250-700 ms; com speed 0.1, 25-70 ms.
    assert.ok((decision.durationMs ?? 0) >= 25 && (decision.durationMs ?? 0) <= 70, `durationMs ${decision.durationMs}`);
    assert.ok(elapsed >= (decision.durationMs ?? 0) * 0.8, `esperou ${elapsed}`);
    const instant = createDemoAdapter({ speed: 0 });
    const t0 = performance.now();
    const quick = await instant.decide(requestFor(SCENARIOS.opening.fen, "rival-random"));
    assert.equal(quick.durationMs, 0);
    assert.ok(performance.now() - t0 < 200);
  });

  it("respeita budgetMs: latência acima do relógio volta como estouro", async () => {
    const adapter = createDemoAdapter({ speed: 1 });
    const started = performance.now();
    const decision = await adapter.decide(requestFor(SCENARIOS.opening.fen, "rival-random", { budgetMs: 40 }));
    const elapsed = performance.now() - started;
    assert.equal(decision.failureReason, "relógio esgotado");
    assert.equal(decision.durationMs, 40);
    assert.ok(elapsed < 400, `esperou ${elapsed}`);
    assert.equal(decision.costUsd, null);
  });

  it("a sessão com relógio curto perde por tempo diante do rival lento", async () => {
    const store = createSessionStore(createDemoAdapter({ speed: 1 }), { clockLimitMs: 60 });
    const created = store.create({
      mode: "battle",
      scenarioId: "game",
      participants: [
        { slot: 0, provider: "demo", modelId: "rival-random" },
        { slot: 1, provider: "demo", modelId: "rival-greedy" },
      ],
    });
    const result = await store.decide(created.sessionId, 0);
    assert.equal(result.session.outcome?.kind, "timeout");
    assert.equal(result.session.outcome?.winnerSlot, 1);
    assert.equal(result.applied, false);
  });

  it("modelo desconhecido falha com motivo e sem lance", async () => {
    const decision = await createDemoAdapter({ speed: 0 }).decide(requestFor(SCENARIOS.opening.fen, "nao-existe"));
    assert.equal(decision.choiceId, null);
    assert.equal(decision.failureReason, "modelo demo desconhecido");
  });

  it("sem lances legais não inventa um", async () => {
    const mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const decision = await createDemoAdapter({ speed: 0 }).decide(requestFor(mated, "jev-demo"));
    assert.equal(decision.choiceId, null);
    assert.equal(decision.failureReason, "sem lances legais");
  });
});
