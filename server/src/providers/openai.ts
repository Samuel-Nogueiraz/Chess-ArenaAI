import {
  buildCorrection,
  buildMovePrompt,
  MOVE_SYSTEM_PROMPT,
  type AdapterDecision,
  type DecisionContext,
} from "@arena/core";
import type { OpenAiEntry } from "../config.js";
import { askWithCorrection, type TextAttempt } from "./loop.js";
import { httpFailureReason } from "./jev.js";
import type { ProviderModule } from "./registry.js";
import { estimateCost, failedDecision, finite } from "./util.js";

export interface OpenAiResponse {
  status: number;
  json(): Promise<unknown>;
}

export type OpenAiFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<OpenAiResponse>;

export interface OpenAiDeps {
  fetch?: OpenAiFetch;
  env?: Record<string, string | undefined>;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Uma conversa com um endpoint `/chat/completions` compatível com OpenAI. */
export async function askOpenAi(
  context: DecisionContext,
  entry: OpenAiEntry,
  deps: OpenAiDeps & { budgetMs?: number | null } = {},
): Promise<AdapterDecision> {
  const env = deps.env ?? process.env;
  const send = deps.fetch ?? ((url, init) => fetch(url, init));
  const prompt = buildMovePrompt(context);
  const apiKey = entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined;
  if (entry.apiKeyEnv && !apiKey) return failedDecision(prompt, "credencial ausente");

  const messages: ChatMessage[] = [{ role: "system", content: MOVE_SYSTEM_PROMPT }];

  return askWithCorrection({
    context,
    prompt,
    budgetMs: deps.budgetMs,
    correction: buildCorrection,
    async ask(text, step): Promise<TextAttempt> {
      if (step.isCorrection) messages.push({ role: "assistant", content: step.previousAnswer || "(sem resposta)" });
      messages.push({ role: "user", content: text });
      return chat(entry, messages, apiKey, send);
    },
  });
}

async function chat(entry: OpenAiEntry, messages: ChatMessage[], apiKey: string | undefined, send: OpenAiFetch): Promise<TextAttempt> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), entry.timeoutMs);
  const elapsed = () => Math.round(performance.now() - started);
  const failed = (failureReason: string, rawResponse: unknown = null): TextAttempt => ({
    text: null,
    failureReason,
    durationMs: elapsed(),
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    modelReturned: null,
    rawResponse,
  });
  try {
    const response = await Promise.race([
      send(`${entry.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: entry.model, temperature: 0, messages }),
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("tempo esgotado"), { name: "AbortError" })), { once: true });
      }),
    ]);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status < 200 || response.status >= 300) return failed(httpFailureReason(response.status, body), null);
    const content = readContent(body);
    if (content == null) return failed("resposta inválida");
    const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
    const inputTokens = finite(usage.prompt_tokens);
    const outputTokens = finite(usage.completion_tokens);
    const cost = estimateCost(inputTokens, outputTokens, entry.inputUsdPerMillion, entry.outputUsdPerMillion);
    return {
      text: content,
      failureReason: null,
      durationMs: elapsed(),
      inputTokens,
      outputTokens,
      costUsd: cost.costUsd,
      costNature: cost.costNature,
      modelReturned: isRecord(body) && typeof body.model === "string" ? body.model : entry.model,
      rawResponse: { model: entry.model, result: content.trim().slice(0, 200) },
    };
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    return failed(aborted ? "tempo esgotado" : "falha de rede");
  } finally {
    clearTimeout(timer);
  }
}

function readContent(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.choices)) return null;
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  return typeof first.message.content === "string" ? first.message.content : null;
}

export function createOpenAiProvider(entries: OpenAiEntry[], deps: OpenAiDeps = {}): ProviderModule {
  const env = deps.env ?? process.env;
  const usable = () => entries.filter((entry) => !entry.apiKeyEnv || Boolean(env[entry.apiKeyEnv]));
  return {
    id: "openai",
    label: "API compatível com OpenAI",
    kind: "api",
    strictModels: true,
    async status() {
      if (entries.length === 0) return { available: false, reason: 'nenhuma entrada "openai" em arena.config.json' };
      if (usable().length === 0) {
        const names = [...new Set(entries.map((entry) => entry.apiKeyEnv).filter((name): name is string => Boolean(name)))];
        return { available: false, reason: `${names.join(", ")} ausente` };
      }
      return { available: true, reason: null };
    },
    async models() {
      return usable().map((entry) => ({ id: entry.id, label: entry.label }));
    },
    decide(request) {
      const entry = entries.find((item) => item.id === request.participant.modelId);
      if (!entry) return Promise.resolve(failedDecision(request.context.objective, "modelo não configurado"));
      return askOpenAi(request.context, entry, { ...deps, env, budgetMs: request.budgetMs ?? null });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
