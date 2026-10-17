import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyUci, inspect, matingMoves } from "../src/engine.js";
import { CLOCK_LIMIT_MS, createSessionStore } from "../src/session.js";
import { CHECK_OBJECTIVE_SINGLE, DRAW_KINGS_FEN, SCENARIOS } from "../src/scenarios.js";
import { exportHasSecret } from "../src/sanitize.js";
import type { AdapterRequest, DecisionAdapter, Participant } from "../src/types.js";

const participants: Participant[] = [
  { slot: 0, provider: "jev", modelId: "jev-latest" },
  { slot: 1, provider: "cursor", modelId: "id-da-lista" },
];

function scripted(steps: Array<{ choiceId?: string; failureReason?: string; hang?: Promise<void>; rawResponse?: unknown }>) {
  const calls: AdapterRequest[] = [];
  const adapter: DecisionAdapter = {
    async decide(input) {
      calls.push(input);
      const step = steps.shift();
      if (!step) throw new Error("sem passo");
      if (step.hang) await step.hang;
      return {
        choiceId: step.choiceId ?? null,
        modelReturned: step.choiceId ? "jev-1.13.0" : null,
        rawResponse: step.rawResponse ?? { choiceId: step.choiceId ?? null },
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        costNature: "unavailable",
        sdkDurationMs: null,
        durationMs: null,
        failureReason: step.failureReason ?? null,
        confidence: null,
        distribution: null,
        prompt: input.context.objective,
        preludes: [],
      };
    },
  };
  return { adapter, calls };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condição não aconteceu");
}

describe("sessão", () => {
  it("o adaptador recebe o último lance aplicado do adversário", async () => {
    const play = scripted([{ choiceId: "e2e4" }, { choiceId: "e7e5" }]);
    const store = createSessionStore(play.adapter);
    const created = store.create({ mode: "battle", scenarioId: "game", participants });
    await store.decide(created.sessionId, 0);
    await store.decide(created.sessionId, 1);
    assert.equal(play.calls[0]?.context.lastMove, null);
    assert.deepEqual(play.calls[1]?.context.lastMove, { id: "e2e4", san: "e4" });
  });

  it("cada lado tem 5 minutos e só desconta o tempo da própria chamada", async () => {
    const slow = deferred();
    const play = scripted([{ choiceId: "e2e4", hang: slow.promise }]);
    const store = createSessionStore(play.adapter);
    const created = store.create({ mode: "battle", scenarioId: "game", participants });
    assert.deepEqual(created.clock, { limitMs: CLOCK_LIMIT_MS, remainingMs: [CLOCK_LIMIT_MS, CLOCK_LIMIT_MS] });
    setTimeout(() => slow.resolve(), 30);
    const played = await store.decide(created.sessionId, 0);
    assert.equal(played.applied, true);
    const [white, black] = played.session.clock?.remainingMs ?? [0, 0];
    assert.ok(white <= CLOCK_LIMIT_MS - 25 && white > CLOCK_LIMIT_MS - 5_000);
    assert.equal(black, CLOCK_LIMIT_MS);
    const compared = store.create({ mode: "compare", scenarioId: "opening", participants });
    assert.equal(compared.clock, null);
  });

  it("relógio esgotado corta a chamada, descarta o lance e dá vitória por tempo", async () => {
    const late = deferred();
    const play = scripted([{ choiceId: "e2e4", hang: late.promise }]);
    const store = createSessionStore(play.adapter, { clockLimitMs: 40 });
    const created = store.create({ mode: "battle", scenarioId: "game", participants });
    const flagged = await store.decide(created.sessionId, 0);
    late.resolve();
    assert.equal(flagged.applied, false);
    assert.equal(flagged.decision?.validation, "falha");
    assert.equal(flagged.decision?.failureReason, "relógio esgotado");
    assert.equal(flagged.session.fen, SCENARIOS.game.fen);
    assert.equal(flagged.session.status, "ended");
    assert.equal(flagged.session.outcome?.kind, "timeout");
    assert.equal(flagged.session.outcome?.winnerSlot, 1);
    assert.match(flagged.session.outcome?.label ?? "", /As brancas esgotaram/);
    assert.deepEqual(flagged.session.clock?.remainingMs, [0, 40]);
    const after = await store.decide(created.sessionId, 1);
    assert.equal(after.blocked, true);
    assert.equal(play.calls.length, 1);
  });

  it("tempo esgotado contra quem só tem o rei termina empatado", async () => {
    const late = deferred();
    const play = scripted([{ choiceId: "e2e3", hang: late.promise }]);
    const store = createSessionStore(play.adapter, { clockLimitMs: 20 });
    const created = store.create({ mode: "battle", scenarioId: "game", participants, fen: "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1" });
    const flagged = await store.decide(created.sessionId, 0);
    late.resolve();
    assert.equal(flagged.session.outcome?.kind, "draw");
    assert.equal(flagged.session.outcome?.reason, "tempo esgotado sem material para mate");
  });

  it("X-T01 aplica um UCI legal e uma falha deixa o FEN inicial", async () => {
    const quiet = scripted([]);
    const store = createSessionStore(quiet.adapter);
    const created = store.create({ mode: "battle", scenarioId: "opening", participants });
    assert.equal(created.history.length, 0);
    assert.equal(created.sideToMove, "w");
    assert.ok(created.candidates.some((candidate) => candidate.id === "e2e4"));
    const played = await store.decide(created.sessionId, 0, "e2e4");
    assert.equal(played.decision?.validation, "aceita");
    assert.equal(played.decision?.mode, "real");
    assert.equal(played.applied, true);
    assert.equal(played.fen, SCENARIOS.opening.fen);
    assert.equal(played.session?.fen, applyUci(SCENARIOS.opening.fen, "e2e4").fen);
    assert.equal(quiet.calls.length, 0);

    const refused = await store.decide(store.create({ mode: "battle", scenarioId: "opening", participants }).sessionId, 0, "e9e9");
    assert.equal(refused.decision?.validation, "recusada");
    assert.equal(refused.applied, false);
    assert.equal(refused.session?.fen, SCENARIOS.opening.fen);
    assert.equal(refused.session?.sideToMove, "w");

    const failing = scripted([{ failureReason: "credencial ausente" }]);
    const failedStore = createSessionStore(failing.adapter);
    const open = failedStore.create({ mode: "battle", scenarioId: "opening", participants });
    const failure = await failedStore.decide(open.sessionId, 0);
    assert.equal(failure.decision?.validation, "falha");
    assert.equal(failure.decision?.failureReason, "credencial ausente");
    assert.equal(failure.decision?.inputTokens, null);
    assert.equal(failure.decision?.costUsd, null);
    assert.equal(failure.session?.fen, SCENARIOS.opening.fen);
    assert.equal(failure.session?.outcome, null);
    assert.equal(failure.session?.status, "failed");
    assert.equal(typeof failure.decision?.durationMs, "number");
  });

  it("X-T02 separa lance legal de lance que é mate", async () => {
    const mates = matingMoves(SCENARIOS.mate.fen).map((candidate) => candidate.id);
    assert.deepEqual(mates, ["h5f7"]);
    const quiet = inspect(SCENARIOS.mate.fen).candidates.find((candidate) => !mates.includes(candidate.id));
    assert.ok(quiet);
    const store = createSessionStore(scripted([]).adapter);
    const legal = store.create({ mode: "battle", scenarioId: "mate", participants });
    const accepted = await store.decide(legal.sessionId, 0, quiet.id);
    assert.equal(accepted.decision?.validation, "aceita");
    assert.equal(accepted.mate, false);
    assert.equal(accepted.session?.outcome, null);
    assert.equal(accepted.session?.fen, applyUci(SCENARIOS.mate.fen, quiet.id).fen);

    const mating = store.create({ mode: "battle", scenarioId: "mate", participants });
    const mate = await store.decide(mating.sessionId, 0, "h5f7");
    assert.equal(mate.decision?.validation, "aceita");
    assert.equal(mate.mate, true);
    assert.equal(mate.session?.outcome?.kind, "checkmate");
    assert.equal(mate.session?.outcome?.winnerSlot, 0);
    assert.match(mate.session?.outcome?.label ?? "", /Qxf7#/);
    assert.equal(mate.session?.status, "ended");

    const illegal = store.create({ mode: "battle", scenarioId: "mate", participants });
    const refused = await store.decide(illegal.sessionId, 0, "a1a2");
    assert.equal(refused.decision?.validation, "recusada");
    assert.equal(refused.mate, false);
    assert.equal(refused.session?.outcome, null);
    assert.equal(refused.session?.fen, SCENARIOS.mate.fen);
  });

  it("X-T03 aplica a única saída de xeque e a recusa não muda o turno", async () => {
    const view = inspect(SCENARIOS.check.fen);
    const store = createSessionStore(scripted([]).adapter);
    const created = store.create({ mode: "battle", scenarioId: "check", participants });
    assert.equal(created.inCheck, true);
    assert.equal(created.candidates.length, view.candidates.length);
    assert.equal(created.objective, CHECK_OBJECTIVE_SINGLE);
    assert.deepEqual(created.candidates.map((candidate) => candidate.id), ["a1b1"]);
    const played = await store.decide(created.sessionId, 0, "a1b1");
    assert.equal(played.applied, true);
    assert.equal(played.session?.fen, applyUci(SCENARIOS.check.fen, "a1b1").fen);
    assert.equal(played.session?.sideToMove, "b");

    const again = store.create({ mode: "battle", scenarioId: "check", participants });
    const refused = await store.decide(again.sessionId, 0, "e2e4");
    assert.equal(refused.decision?.validation, "recusada");
    assert.equal(refused.session?.fen, again.fen);
    assert.equal(refused.session?.sideToMove, "w");
    assert.equal(refused.session?.history[0]?.validation, "recusada");
  });

  it("X-T05 recusa id fora da lista desta sessão e deste FEN", async () => {
    const store = createSessionStore(scripted([]).adapter);
    const created = store.create({ mode: "compare", scenarioId: "opening", participants });
    const refused = await store.decide(created.sessionId, 0, "e7e8q");
    assert.equal(refused.decision?.validation, "recusada");
    assert.equal(refused.decision?.failureReason, "id fora da lista");
    assert.equal(refused.applied, false);
    assert.equal(refused.session?.fen, created.fen);
    assert.equal(refused.session?.sideToMove, created.sideToMove);
    assert.equal(refused.session?.history.length, 1);
    assert.equal(typeof refused.decision?.durationMs, "number");
  });

  it("X-T06 ignora a resposta da sessão anterior", async () => {
    const gate = deferred();
    const script = scripted([{ choiceId: "e2e4", hang: gate.promise }]);
    const store = createSessionStore(script.adapter);
    const first = store.create({ mode: "battle", scenarioId: "opening", participants });
    const pending = store.decide(first.sessionId, 0);
    await until(() => script.calls.length === 1);
    const second = await store.restart(first.sessionId);
    assert.notEqual(second.sessionId, first.sessionId);
    gate.resolve();
    const late = await pending;
    assert.equal(late.ignored, true);
    const active = store.get(second.sessionId);
    assert.equal(active.fen, SCENARIOS.opening.fen);
    assert.equal(active.history.length, 0);
    assert.equal(active.sideToMove, "w");
    const archived = store.get(first.sessionId);
    assert.equal(archived.history.length, 0);
    assert.equal(archived.fen, SCENARIOS.opening.fen);
  });

  it("X-T07 a pausa não dispara outra chamada e o lance em voo aplica uma vez", async () => {
    const gate = deferred();
    const script = scripted([
      { choiceId: "e2e4", hang: gate.promise },
      { choiceId: "e7e5" },
    ]);
    const store = createSessionStore(script.adapter);
    const created = store.create({ mode: "battle", scenarioId: "opening", participants });
    const running = store.start(created.sessionId);
    await until(() => script.calls.length === 1);
    const paused = await store.pause(created.sessionId);
    assert.equal(paused.status, "paused");
    assert.equal(script.calls.length, 1);
    gate.resolve();
    await running;
    const mid = store.get(created.sessionId);
    assert.equal(script.calls.length, 1);
    assert.equal(mid.status, "paused");
    const afterFirst = applyUci(SCENARIOS.opening.fen, "e2e4").fen;
    assert.equal(mid.fen, afterFirst);
    assert.equal(mid.history.filter((entry) => entry.logical).length, 1);
    const continued = await store.step(created.sessionId);
    assert.equal(script.calls.length, 2);
    assert.equal(script.calls[1]?.context.fen, afterFirst);
    assert.equal(continued.session?.fen, applyUci(afterFirst, "e7e5").fen);
    assert.notEqual(continued.session?.fen, afterFirst);
    assert.equal(continued.session?.status, "paused");
    assert.equal(continued.session?.history.filter((entry) => entry.logical).length, 2);
  });

  it("X-T08 empate não chama o modelo e parar não cria vencedor", async () => {
    const drawScript = scripted([{ choiceId: "e2e4" }]);
    const store = createSessionStore(drawScript.adapter);
    const draw = store.create({
      mode: "battle",
      scenarioId: "opening",
      participants,
      fen: DRAW_KINGS_FEN,
    });
    assert.equal(draw.fen, DRAW_KINGS_FEN);
    assert.equal(draw.outcome?.kind, "draw");
    assert.equal(draw.outcome?.reason, "material insuficiente");
    assert.match(draw.outcome?.label ?? "", /^Empate · /);
    assert.equal(draw.status, "ended");
    const blocked = await store.decide(draw.sessionId, 0);
    assert.equal(blocked.blocked, true);
    assert.equal(drawScript.calls.length, 0);
    assert.equal(store.get(draw.sessionId).history.length, 0);

    const mateStore = createSessionStore(scripted([]).adapter);
    const mate = mateStore.create({ mode: "battle", scenarioId: "mate", participants });
    const victory = await mateStore.decide(mate.sessionId, 0, "h5f7");
    assert.equal(victory.session?.outcome?.kind, "checkmate");
    assert.equal(victory.session?.outcome?.winnerSlot, 0);

    const stopStore = createSessionStore(scripted([]).adapter);
    const plain = stopStore.create({ mode: "battle", scenarioId: "opening", participants });
    const stopped = await stopStore.stop(plain.sessionId);
    assert.equal(stopped.outcome?.label, "Interrompida · sem vencedor");
    assert.equal(stopped.outcome?.winnerSlot, undefined);
    assert.equal(stopped.status, "stopped");
    const afterStop = await stopStore.decide(plain.sessionId, 0, "e2e4");
    assert.equal(afterStop.blocked, true);
    assert.equal(stopStore.get(plain.sessionId).fen, SCENARIOS.opening.fen);

    const moved = stopStore.create({ mode: "battle", scenarioId: "opening", participants });
    await stopStore.decide(moved.sessionId, 0, "e2e4");
    const stoppedLater = await stopStore.stop(moved.sessionId);
    assert.equal(stoppedLater.outcome?.label, "Interrompida · sem vencedor");
    assert.equal(stoppedLater.fen, applyUci(SCENARIOS.opening.fen, "e2e4").fen);
    assert.equal(stoppedLater.outcome?.kind, "stopped");
  });

  it("na comparação a falha do slot 0 não cancela o slot 1 e o FEN fica intacto", async () => {
    const script = scripted([{ failureReason: "tempo esgotado" }, { choiceId: "e2e4" }]);
    const store = createSessionStore(script.adapter);
    const created = store.create({ mode: "compare", scenarioId: "opening", participants });
    const first = await store.decide(created.sessionId, 0);
    const second = await store.decide(created.sessionId, 1);
    assert.equal(first.decision?.validation, "falha");
    assert.equal(second.decision?.validation, "aceita");
    assert.equal(second.applied, false);
    assert.equal(second.session?.fen, SCENARIOS.opening.fen);
    assert.equal(script.calls[0]?.context.fen, script.calls[1]?.context.fen);
    assert.deepEqual(
      script.calls[0]?.context.candidates.map((candidate) => candidate.id),
      script.calls[1]?.context.candidates.map((candidate) => candidate.id),
    );
    assert.equal(second.session?.history.length, 2);
    assert.ok((second.session?.totals.durationSumMs ?? 0) >= 0);
    assert.ok((second.session?.totals.sessionClockMs ?? -1) >= 0);
  });

  it("exportação não leva Authorization nem chave", async () => {
    const script = scripted([
      {
        choiceId: "e2e4",
        rawResponse: {
          Authorization: "Bearer super-secret-value",
          note: "Authorization: Bearer super-secret-value",
        },
      },
    ]);
    const store = createSessionStore(script.adapter);
    const created = store.create({ mode: "compare", scenarioId: "defense", participants });
    await store.decide(created.sessionId, 0);
    const exported = store.exportSession(created.sessionId);
    assert.equal(exportHasSecret(exported), false);
    assert.equal(JSON.stringify(exported).includes("super-secret-value"), false);
  });

  it("trocar o modelo abre outra sessão", () => {
    const store = createSessionStore(scripted([]).adapter);
    const first = store.create({ mode: "compare", scenarioId: "defense", participants });
    const second = store.create({
      mode: "compare",
      scenarioId: "defense",
      participants: [
        participants[0],
        { slot: 1, provider: "cursor", modelId: "outro-id-da-lista" },
      ],
    });
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(second.history.length, 0);
    assert.equal(store.activeId(), second.sessionId);
  });
});
