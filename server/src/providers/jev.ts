import {
  choiceLabel,
  jevCost,
  positionBrief,
  type AdapterDecision,
  type DecisionContext,
  type ProviderAttempt,
} from "@arena/core";
import type { ProviderModule } from "./registry.js";
import { sleep } from "./util.js";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export function resolveJevModel(env: Record<string, string | undefined> = process.env) {
  const value = env.JEV_MODEL;
  if (typeof value === "string" && value.trim()) return value.trim();
  return JEV_MODEL;
}
export const JEV_QUESTION_ID = "lance";
export const JEV_TIMEOUT_MS = 30_000;
export const JEV_MAX_RETRIES = 2;
export const CHOICE_LIMIT = 255;

export interface JevFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface JevDeps {
  apiKey: string | undefined;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<JevFetchResponse>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
  maxRetries?: number;
  model?: string;
}

export function buildJevRequest(context: DecisionContext, model: string = resolveJevModel()) {
  const limited = context.candidates.slice(0, CHOICE_LIMIT);
  const criteria: Record<string, string | null> = {};
  for (const candidate of limited) criteria[candidate.id] = choiceLabel({ ...context, candidates: [candidate] }, candidate);
  const ids = limited.map((candidate) => candidate.id);
  const instructions = [
    positionBrief(context),
    "Choose exactly one move id from legal_moves.",
    "The ids are UCI. Do not invent a move outside legal_moves.",
    `FEN: ${context.fen}`,
    `Side to move: ${context.sideToMove === "w" ? "white" : "black"}`,
    `Game: ${context.sessionId}`,
    `Objective: ${context.objective}`,
  ].join("\n");
  return {
    model,
    state: `FEN ${context.fen}\nlegal_moves ${ids.join(" ")}`,
    questions: {
      [JEV_QUESTION_ID]: {
        type: "choice" as const,
        instructions,
        criteria,
      },
    },
  };
}

export function retryDelayMs(header: string | null, attempt: number, now: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dated = Date.parse(header);
    if (Number.isFinite(dated)) return Math.max(0, dated - now);
  }
  return 200 * 2 ** attempt;
}

export function httpFailureReason(status: number, body: unknown): string {
  const base =
    status === 401 ? "credencial recusada"
    : status === 422 ? "corpo recusado"
    : status === 429 ? "limite de taxa"
    : status === 529 ? "provedor sobrecarregado"
    : status >= 500 ? "falha do provedor"
    : "pedido recusado";
  const detail = bodyDetail(body);
  return detail ? `${base}. ${detail}` : base;
}

export async function askJev(context: DecisionContext, deps: JevDeps): Promise<AdapterDecision> {
  const prompt = buildJevRequest(context, deps.model).questions[JEV_QUESTION_ID]?.instructions ?? "";
  if (!deps.apiKey) return failed(prompt, "credencial ausente");

  const body = buildJevRequest(context, deps.model);
  const timeoutMs = deps.timeoutMs ?? JEV_TIMEOUT_MS;
  const maxRetries = deps.maxRetries ?? JEV_MAX_RETRIES;
  const now = deps.now ?? Date.now;
  const preludes: ProviderAttempt[] = [];
  let attempt = 0;

  while (true) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("tempo esgotado");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
    try {
      const response = await Promise.race([
        deps.fetch(JEV_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
        timedOut,
      ]);
      const durationMs = Math.round(performance.now() - started);
      const parsed = await readBody(response);
      if ((response.status === 429 || response.status === 529) && attempt < maxRetries) {
        preludes.push(prelude(durationMs, httpFailureReason(response.status, parsed.body), parsed.body));
        const delay = retryDelayMs(response.headers.get("retry-after"), attempt, now());
        attempt += 1;
        await deps.sleep(delay);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        return failed(prompt, httpFailureReason(response.status, parsed.body), durationMs, parsed.body, preludes);
      }
      if (!parsed.ok) return failed(prompt, "resposta inválida", durationMs, parsed.body, preludes);
      const answer = readAnswer(parsed.body);
      if (!answer.ok) return failed(prompt, "resposta inválida", durationMs, parsed.body, preludes);
      const cost = jevCost(answer.inputTokens);
      return {
        choiceId: answer.choiceId,
        modelReturned: answer.modelReturned,
        rawResponse: parsed.body,
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
        costUsd: cost.costUsd,
        costNature: cost.costNature,
        sdkDurationMs: null,
        durationMs,
        failureReason: null,
        confidence: answer.confidence,
        distribution: answer.distribution,
        prompt,
        preludes,
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const timedOut = isTimeout(error) || controller.signal.aborted || isAbort(error);
      return failed(prompt, timedOut ? "tempo esgotado" : "falha de rede", durationMs, null, preludes);
    } finally {
      clearTimeout(timer);
    }
  }
}

function prelude(durationMs: number, failureReason: string, rawResponse: unknown): ProviderAttempt {
  return {
    logical: false,
    durationMs,
    failureReason,
    modelReturned: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    rawResponse,
  };
}

function failed(
  prompt: string,
  failureReason: string,
  durationMs: number | null = null,
  rawResponse: unknown = null,
  preludes: ProviderAttempt[] = [],
): AdapterDecision {
  return {
    choiceId: null,
    modelReturned: null,
    rawResponse,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    sdkDurationMs: null,
    durationMs,
    failureReason,
    confidence: null,
    distribution: null,
    prompt,
    preludes,
  };
}

async function readBody(response: JevFetchResponse): Promise<{ ok: boolean; body: unknown }> {
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, body: null };
  }
}

function readAnswer(body: unknown): {
  ok: boolean;
  choiceId: string | null;
  modelReturned: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  confidence: number | null;
  distribution: Record<string, number> | null;
} {
  if (!body || typeof body !== "object") {
    return { ok: false, choiceId: null, modelReturned: null, inputTokens: null, outputTokens: null, confidence: null, distribution: null };
  }
  const record = body as Record<string, unknown>;
  const modelReturned = typeof record.model === "string" ? record.model : null;
  const usage = record.usage;
  const usageRecord = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined;
  const inputTokens = finite(usageRecord?.input_tokens);
  const outputTokens = finite(usageRecord?.output_tokens);
  const first = readChoiceAnswer(record.answers);
  if (!first) {
    return { ok: false, choiceId: null, modelReturned, inputTokens, outputTokens, confidence: null, distribution: null };
  }
  const choice = first.choice ?? first.value ?? first.selected ?? first.answer;
  if (typeof choice !== "string" || choice.length === 0) {
    return { ok: false, choiceId: null, modelReturned, inputTokens, outputTokens, confidence: null, distribution: null };
  }
  return {
    ok: true,
    choiceId: choice,
    modelReturned,
    inputTokens,
    outputTokens,
    confidence: finite(first.confidence),
    distribution: readDistribution(first.probabilities ?? first.distribution),
  };
}

function readChoiceAnswer(answers: unknown): Record<string, unknown> | null {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const map = answers as Record<string, unknown>;
  const named = map[JEV_QUESTION_ID];
  if (named && typeof named === "object" && !Array.isArray(named)) return named as Record<string, unknown>;
  const values = Object.values(map).filter((item) => item && typeof item === "object" && !Array.isArray(item));
  return values.length === 1 ? (values[0] as Record<string, unknown>) : null;
}

function bodyDetail(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const detail = record.detail;
  if (Array.isArray(detail)) {
    const first = detail.find((item) => item && typeof item === "object");
    if (first && typeof first === "object") {
      const item = first as Record<string, unknown>;
      const loc = Array.isArray(item.loc)
        ? item.loc.filter((part) => part !== "body").map((part) => String(part)).join(".")
        : "";
      const msg = typeof item.msg === "string" ? item.msg : "";
      return cleanDetail([loc, msg].filter(Boolean).join(": "));
    }
  }
  if (typeof detail === "string") return cleanDetail(detail);
  const message = typeof record.message === "string" ? record.message : record.error;
  if (typeof message === "string") return cleanDetail(message);
  if (message && typeof message === "object" && typeof (message as Record<string, unknown>).message === "string") {
    return cleanDetail((message as Record<string, unknown>).message as string);
  }
  return null;
}

function cleanDetail(text: string): string | null {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact || /authorization|bearer|api[_ -]?key|secret/i.test(compact)) return null;
  return compact.slice(0, 140);
}

function readDistribution(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const count = finite(item);
    if (count != null) out[key] = count;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "timeout" in error);
}

export interface JevProviderDeps {
  env?: Record<string, string | undefined>;
  fetch?: JevDeps["fetch"];
  sleep?: JevDeps["sleep"];
}

export function createJevProvider(deps: JevProviderDeps = {}): ProviderModule {
  const env = deps.env ?? process.env;
  return {
    id: "jev",
    label: "JEV · TypeSafe API",
    kind: "api",
    async status() {
      return env.TYPESAFE_API_KEY
        ? { available: true, reason: null }
        : { available: false, reason: "TYPESAFE_API_KEY ausente" };
    },
    async models() {
      return [{ id: resolveJevModel(env), label: "JEV" }];
    },
    decide(request) {
      return askJev(request.context, {
        apiKey: env.TYPESAFE_API_KEY,
        fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
        sleep: deps.sleep ?? sleep,
        model: resolveJevModel(env),
      });
    },
  };
}
