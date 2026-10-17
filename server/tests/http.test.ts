import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { exportHasSecret, SCENARIOS, type AdapterDecision, type AdapterRequest, type ProviderId } from "@arena/core";
import { createApp } from "../src/http.js";
import { createDemoProvider } from "../src/providers/demo.js";
import { createRegistry, type ProviderModule } from "../src/providers/registry.js";

const participants = [
  { slot: 0, provider: "jev", modelId: "jev-latest" },
  { slot: 1, provider: "cursor", modelId: "id-da-lista" },
];

const SECRET = "chave-de-teste-que-nunca-pode-vazar";

function idleDecision(request: AdapterRequest): AdapterDecision {
  return {
    choiceId: "e2e4",
    modelReturned: null,
    rawResponse: { ok: true },
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    sdkDurationMs: null,
    durationMs: null,
    failureReason: null,
    confidence: null,
    distribution: null,
    prompt: request.context.objective,
    preludes: [],
  };
}

function fake(id: ProviderId, options: { available?: boolean; reason?: string; decide?: (request: AdapterRequest) => Promise<AdapterDecision> } = {}): ProviderModule {
  const available = options.available ?? true;
  return {
    id,
    label: `falso ${id}`,
    kind: "api",
    async status() {
      return { available, reason: available ? null : (options.reason ?? "indisponível") };
    },
    async models() {
      return [{ id: `${id}-modelo`, label: `Modelo ${id}` }];
    },
    async decide(request: AdapterRequest) {
      if (options.decide) return options.decide(request);
      throw new Error("a rota de teste não deveria chamar o provedor");
    },
  };
}

async function withApp(
  modules: ProviderModule[],
  run: (base: string, app: ReturnType<typeof createApp>) => Promise<void>,
  extra: { staticDir?: string } = {},
) {
  const app = createApp({ registry: createRegistry(modules), ...extra });
  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = app.server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, app);
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const json = { "content-type": "application/json" };

describe("HTTP", () => {
  it("responde /api/health e lista provedores sem expor nenhuma chave", async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = SECRET;
    try {
      await withApp([createDemoProvider(), fake("jev"), fake("cursor", { available: false, reason: "CURSOR_API_KEY ausente" })], async (base) => {
        const health = await (await fetch(`${base}/api/health`)).json();
        assert.equal(health.ok, true);
        assert.equal(health.mode, "live");
        assert.equal(typeof health.version, "string");

        const response = await fetch(`${base}/api/providers`);
        const text = await response.text();
        assert.equal(text.includes(SECRET), false);
        const body = JSON.parse(text);
        assert.deepEqual(body.providers.map((provider: { id: string }) => provider.id), ["demo", "jev", "cursor"]);
        const demo = body.providers[0];
        assert.equal(demo.available, true);
        assert.equal(demo.reason, null);
        assert.equal(demo.kind, "demo");
        assert.deepEqual(demo.models.map((model: { id: string }) => model.id), ["jev-demo", "rival-greedy", "rival-random"]);
        const cursor = body.providers[2];
        assert.equal(cursor.available, false);
        assert.equal(cursor.reason, "CURSOR_API_KEY ausente");

        assert.equal((await fetch(`${base}/api/models`)).status, 404);
      });
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });

  it("recusa com 400 criar sessão com provedor indisponível ou modelo desconhecido", async () => {
    await withApp([createDemoProvider(), fake("jev", { available: false, reason: "TYPESAFE_API_KEY ausente" })], async (base) => {
      const unavailable = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          mode: "battle",
          scenarioId: "mate",
          participants: [
            { slot: 0, provider: "jev", modelId: "jev-latest" },
            { slot: 1, provider: "demo", modelId: "rival-greedy" },
          ],
        }),
      });
      assert.equal(unavailable.status, 400);
      const body = await unavailable.json();
      assert.match(body.error, /jev/);
      assert.match(body.error, /TYPESAFE_API_KEY ausente/);

      const unknown = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          mode: "battle",
          scenarioId: "mate",
          participants: [
            { slot: 0, provider: "demo", modelId: "jev-demo" },
            { slot: 1, provider: "demo", modelId: "nao-existe" },
          ],
        }),
      });
      assert.equal(unknown.status, 400);

      const legacy = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          mode: "battle",
          scenarioId: "mate",
          participants: [
            { slot: 0, provider: "typesafe", modelId: "jev-latest" },
            { slot: 1, provider: "demo", modelId: "rival-greedy" },
          ],
        }),
      });
      assert.equal(legacy.status, 400);
    });
  });

  it("joga uma sessão demo pelo servidor: jev-demo acha o mate e a decisão sai marcada como demo", async () => {
    await withApp([createDemoProvider({ speed: 0 })], async (base) => {
      const created = await (await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          mode: "battle",
          scenarioId: "mate",
          participants: [
            { slot: 0, provider: "demo", modelId: "jev-demo" },
            { slot: 1, provider: "demo", modelId: "rival-greedy" },
          ],
        }),
      })).json();
      const decided = await (await fetch(`${base}/api/sessions/${created.sessionId}/decide`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ slot: 0 }),
      })).json();
      assert.equal(decided.decision.choiceId, "h5f7");
      assert.equal(decided.decision.mode, "demo");
      assert.equal(decided.decision.costNature, "estimated");
      assert.equal(decided.applied, true);
      assert.equal(decided.mate, true);
      assert.equal(decided.session.outcome.kind, "checkmate");
    });
  });

  it("cria sessão, decide sem rede e exporta sem segredo", async () => {
    await withApp([fake("jev"), fake("cursor")], async (base) => {
      const createdResponse = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ mode: "compare", scenarioId: "opening", participants }),
      });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      assert.equal(created.scenarioId, "opening");
      assert.equal(created.fen, SCENARIOS.opening.fen);
      assert.equal(created.sideToMove, "w");
      assert.equal(created.outcome, null);
      assert.equal(created.status, "ready");
      assert.deepEqual(created.history, []);
      assert.ok(created.candidates.some((candidate: { id: string }) => candidate.id === "e2e4"));

      const decidedResponse = await fetch(`${base}/api/sessions/${created.sessionId}/decide`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ slot: 0, injectedChoiceId: "e2e4" }),
      });
      const decided = await decidedResponse.json();
      assert.equal(decided.decision.validation, "aceita");
      assert.equal(decided.decision.mode, "real");
      assert.equal(decided.applied, false);
      assert.equal(decided.fen, SCENARIOS.opening.fen);
      assert.equal(decided.session.fen, SCENARIOS.opening.fen);

      const refused = await (await fetch(`${base}/api/sessions/${created.sessionId}/decide`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ slot: 1, injectedChoiceId: "e9e9" }),
      })).json();
      assert.equal(refused.decision.validation, "recusada");
      assert.equal(refused.session.fen, SCENARIOS.opening.fen);

      const exported = await (await fetch(`${base}/api/sessions/${created.sessionId}/export`)).json();
      assert.equal(exportHasSecret(exported), false);
      assert.equal(JSON.stringify(exported).includes("Authorization"), false);
    });
  });

  it("pausa não chama o provedor e parar encerra sem vencedor", async () => {
    let calls = 0;
    const counting = async (request: AdapterRequest) => {
      calls += 1;
      return idleDecision(request);
    };
    await withApp([fake("jev", { decide: counting }), fake("cursor", { decide: counting })], async (base) => {
      const created = await (await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ mode: "battle", scenarioId: "opening", participants }),
      })).json();
      const paused = await (await fetch(`${base}/api/sessions/${created.sessionId}/pause`, { method: "POST" })).json();
      assert.equal(paused.status, "paused");
      const blocked = await (await fetch(`${base}/api/sessions/${created.sessionId}/decide`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ slot: 0 }),
      })).json();
      assert.equal(blocked.blocked, true);
      assert.equal(blocked.reason, "pausada");
      assert.equal(calls, 0);
      assert.equal(blocked.session.fen, SCENARIOS.opening.fen);

      const resumed = await (await fetch(`${base}/api/sessions/${created.sessionId}/resume`, { method: "POST" })).json();
      assert.equal(resumed.status, "ready");
      const stopped = await (await fetch(`${base}/api/sessions/${created.sessionId}/stop`, { method: "POST" })).json();
      assert.equal(stopped.outcome.label, "Interrompida · sem vencedor");
      assert.equal(stopped.status, "stopped");
      const restarted = await (await fetch(`${base}/api/sessions/${created.sessionId}/restart`, { method: "POST" })).json();
      assert.notEqual(restarted.sessionId, created.sessionId);
      assert.equal(restarted.fen, SCENARIOS.opening.fen);
      assert.deepEqual(restarted.history, []);
      assert.equal(calls, 0);
    });
  });

  it("recusa Host e Origin de fora da máquina", async () => {
    await withApp([createDemoProvider()], async (base) => {
      const foreignOrigin = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
      assert.equal(foreignOrigin.status, 403);
      const localOrigin = await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
      assert.equal(localOrigin.status, 200);
    });
  });

  it("serve web/dist com fallback de SPA, ou avisa que falta compilar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-static-"));
    try {
      await withApp([createDemoProvider()], async (base) => {
        const missing = await fetch(`${base}/`);
        assert.equal(missing.status, 404);
        assert.match(await missing.text(), /npm run build/);
      }, { staticDir: dir });

      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "index.html"), "<!doctype html><title>arena</title>");
      writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
      await withApp([createDemoProvider()], async (base) => {
        const root = await fetch(`${base}/`);
        assert.equal(root.status, 200);
        assert.match(root.headers.get("content-type") ?? "", /text\/html/);
        assert.match(await root.text(), /arena/);

        const deep = await fetch(`${base}/partida/123`);
        assert.equal(deep.status, 200);
        assert.match(await deep.text(), /arena/);

        const asset = await fetch(`${base}/assets/app.js`);
        assert.match(asset.headers.get("content-type") ?? "", /javascript/);
        assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

        assert.equal((await fetch(`${base}/assets/nao-existe.js`)).status, 404);
        const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
        assert.notEqual(traversal.status, 200);
        assert.equal((await fetch(`${base}/api/nao-existe`)).status, 404);
      }, { staticDir: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
