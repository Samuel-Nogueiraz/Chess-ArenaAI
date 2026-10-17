import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect, SCENARIOS, type DecisionContext } from "@arena/core";
import type { OpenAiEntry } from "../src/config.js";
import { askOpenAi, createOpenAiProvider, type OpenAiFetch } from "../src/providers/openai.js";

const KEY = "chave-openai-de-teste-12345";

const entry: OpenAiEntry = {
  id: "gpt-mini",
  label: "OpenAI · gpt-4.1-mini",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  model: "gpt-4.1-mini",
  inputUsdPerMillion: 0.4,
  outputUsdPerMillion: 1.6,
  timeoutMs: 5_000,
};

function opening(): DecisionContext {
  const view = inspect(SCENARIOS.opening.fen);
  return { sessionId: "s", fen: view.fen, sideToMove: view.sideToMove, objective: SCENARIOS.opening.objective, candidates: view.candidates };
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: { model: string; temperature: number; messages: Array<{ role: string; content: string }> };
}

function scripted(replies: Array<{ status?: number; body: unknown } | "throw" | "hang">) {
  const seen: Seen[] = [];
  const fetch: OpenAiFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = replies.shift();
    if (next === "throw") throw new Error("offline");
    if (next === "hang") return new Promise(() => undefined);
    if (!next) throw new Error("sem resposta roteirizada");
    return { status: next.status ?? 200, json: async () => next.body };
  };
  return { fetch, seen };
}

function completion(content: string, usage: Record<string, number> | null = { prompt_tokens: 1000, completion_tokens: 10 }) {
  return { body: { model: "gpt-4.1-mini-2025", choices: [{ message: { role: "assistant", content } }], ...(usage ? { usage } : {}) } };
}

describe("OpenAI compatível", () => {
  it("chama /chat/completions com system + user, temperature 0 e a chave só no cabeçalho", async () => {
    const api = scripted([completion("e2e4")]);
    const decision = await askOpenAi(opening(), entry, { fetch: api.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(api.seen.length, 1);
    const call = api.seen[0]!;
    assert.equal(call.url, "https://api.example.test/v1/chat/completions");
    assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(call.body.model, "gpt-4.1-mini");
    assert.equal(call.body.temperature, 0);
    assert.deepEqual(call.body.messages.map((message) => message.role), ["system", "user"]);
    assert.match(call.body.messages[0]!.content, /chess move picker/);
    assert.match(call.body.messages[1]!.content, /legal_moves/);
    assert.equal(JSON.stringify(call.body).includes(KEY), false);

    assert.equal(decision.choiceId, "e2e4");
    assert.equal(decision.failureReason, null);
    assert.equal(decision.modelReturned, "gpt-4.1-mini-2025");
    assert.equal(decision.preludes.length, 0);
    assert.equal(JSON.stringify(decision).includes(KEY), false);
  });

  it("usa prompt_tokens e completion_tokens e estima o custo pelas tarifas do config", async () => {
    const api = scripted([completion("e2e4")]);
    const decision = await askOpenAi(opening(), entry, { fetch: api.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(decision.inputTokens, 1000);
    assert.equal(decision.outputTokens, 10);
    assert.equal(decision.costNature, "estimated");
    assert.ok(Math.abs((decision.costUsd ?? 0) - (1000 * 0.4 + 10 * 1.6) / 1_000_000) < 1e-12);
  });

  it("sem tarifa ou sem usage o custo fica indisponível", async () => {
    const noRates = scripted([completion("e2e4")]);
    const a = await askOpenAi(opening(), { ...entry, inputUsdPerMillion: undefined, outputUsdPerMillion: undefined }, { fetch: noRates.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(a.costUsd, null);
    assert.equal(a.costNature, "unavailable");
    assert.equal(a.inputTokens, 1000);

    const noUsage = scripted([completion("e2e4", null)]);
    const b = await askOpenAi(opening(), entry, { fetch: noUsage.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(b.inputTokens, null);
    assert.equal(b.costUsd, null);
    assert.equal(b.costNature, "unavailable");
  });

  it("corrige uma vez, na mesma conversa, quando o id vem fora da lista", async () => {
    const api = scripted([completion("Acho que a1a5 é bom."), completion("d2d4")]);
    const decision = await askOpenAi(opening(), entry, { fetch: api.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(api.seen.length, 2);
    const second = api.seen[1]!.body.messages;
    assert.deepEqual(second.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.equal(second[2]!.content, "Acho que a1a5 é bom.");
    assert.match(second[3]!.content, /is not in legal_moves/);
    assert.equal(decision.choiceId, "d2d4");
    assert.equal(decision.preludes.length, 1);
    assert.equal(decision.preludes[0]?.failureReason, "id fora da lista");
    assert.equal(decision.preludes[0]?.choiceId, "a1a5");
    assert.equal(decision.preludes[0]?.inputTokens, 1000);
  });

  it("não faz uma terceira chamada se a correção também vier ilegal", async () => {
    const api = scripted([completion("e2e5"), completion("e2e5")]);
    const decision = await askOpenAi(opening(), entry, { fetch: api.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(api.seen.length, 2);
    assert.equal(decision.choiceId, "e2e5");
    assert.equal(decision.failureReason, null);
  });

  it("sem a variável da chave não chama a rede", async () => {
    const api = scripted([]);
    const decision = await askOpenAi(opening(), entry, { fetch: api.fetch, env: {} });
    assert.equal(api.seen.length, 0);
    assert.equal(decision.failureReason, "credencial ausente");
    assert.equal(decision.choiceId, null);
  });

  it("sem apiKeyEnv (Ollama, LM Studio) vai sem Authorization", async () => {
    const api = scripted([completion("e2e4")]);
    const local: OpenAiEntry = { ...entry, apiKeyEnv: undefined, baseUrl: "http://127.0.0.1:11434/v1" };
    const decision = await askOpenAi(opening(), local, { fetch: api.fetch, env: {} });
    assert.equal(api.seen[0]!.headers.Authorization, undefined);
    assert.equal(api.seen[0]!.url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(decision.choiceId, "e2e4");
  });

  it("falhas HTTP, de rede e de tempo viram motivo legível, sem repetir a chamada", async () => {
    const unauthorized = scripted([{ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }]);
    const a = await askOpenAi(opening(), entry, { fetch: unauthorized.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(unauthorized.seen.length, 1);
    assert.equal(a.failureReason?.startsWith("credencial recusada"), true);
    assert.equal(JSON.stringify(a).includes(KEY), false);

    const limited = scripted([{ status: 429, body: {} }]);
    const b = await askOpenAi(opening(), entry, { fetch: limited.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(b.failureReason, "limite de taxa");

    const offline = scripted(["throw"]);
    const c = await askOpenAi(opening(), entry, { fetch: offline.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(c.failureReason, "falha de rede");

    const hung = scripted(["hang"]);
    const d = await askOpenAi(opening(), { ...entry, timeoutMs: 30 }, { fetch: hung.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(d.failureReason, "tempo esgotado");

    const empty = scripted([{ body: { choices: [] } }]);
    const e = await askOpenAi(opening(), entry, { fetch: empty.fetch, env: { OPENAI_API_KEY: KEY } });
    assert.equal(e.failureReason, "resposta inválida");
  });
});

describe("provedor OpenAI", () => {
  it("indisponível sem entradas, e com o nome da variável quando falta a chave", async () => {
    const empty = createOpenAiProvider([], { env: {} });
    const none = await empty.status();
    assert.equal(none.available, false);
    assert.match(none.reason ?? "", /arena\.config\.json/);

    const provider = createOpenAiProvider([entry], { env: {} });
    assert.deepEqual(await provider.status(), { available: false, reason: "OPENAI_API_KEY ausente" });
    assert.deepEqual(await provider.models(), []);
  });

  it("com a chave lista só os modelos utilizáveis e nunca devolve o valor", async () => {
    const other: OpenAiEntry = { ...entry, id: "outro", label: "Outro", apiKeyEnv: "OUTRA_CHAVE" };
    const local: OpenAiEntry = { ...entry, id: "local", label: "Local", apiKeyEnv: undefined };
    const provider = createOpenAiProvider([entry, other, local], { env: { OPENAI_API_KEY: KEY } });
    assert.deepEqual(await provider.status(), { available: true, reason: null });
    assert.deepEqual(await provider.models(), [
      { id: "gpt-mini", label: "OpenAI · gpt-4.1-mini" },
      { id: "local", label: "Local" },
    ]);
    assert.equal(JSON.stringify([await provider.status(), await provider.models()]).includes(KEY), false);
    assert.equal(provider.id, "openai");
  });

  it("decide pela entrada pedida", async () => {
    const api = scripted([completion("e2e4")]);
    const provider = createOpenAiProvider([entry], { env: { OPENAI_API_KEY: KEY }, fetch: api.fetch });
    const context = opening();
    const ok = await provider.decide({ sessionId: "s", slot: 0, participant: { slot: 0, provider: "openai", modelId: "gpt-mini" }, context });
    assert.equal(ok.choiceId, "e2e4");
    const unknown = await provider.decide({ sessionId: "s", slot: 0, participant: { slot: 0, provider: "openai", modelId: "x" }, context });
    assert.equal(unknown.failureReason, "modelo não configurado");
  });
});
