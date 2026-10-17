import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cursorCost,
  endingLines,
  labeledMoves,
  positionBrief,
  type AdapterDecision,
  type CostNature,
  type DecisionContext,
  type ProviderAttempt,
  type Slot,
} from "@arena/core";
import type { ModelOption, ProviderModule } from "./registry.js";

// O SDK do Cursor é dependência opcional: nada aqui importa "@cursor/sdk" de forma estática.
export interface ModelParameterValue {
  id: string;
  value: string;
}

export interface ModelParameterDefinition {
  id: string;
  values: Array<{ value: string }>;
}

interface SdkRun {
  wait(): Promise<{
    status: string;
    result?: string;
    durationMs?: number;
    model?: { id?: string };
    usage?: { inputTokens?: number; outputTokens?: number };
    error?: { message?: string };
  }>;
}

interface SDKAgent {
  send(message: string): Promise<SdkRun>;
  close(): void;
}

interface SdkModel {
  id: string;
  displayName?: string;
  aliases?: string[];
  parameters?: ModelParameterDefinition[];
}

export interface CursorSdk {
  Agent: { create(options: Record<string, unknown>): Promise<SDKAgent> };
  Cursor: { models: { list(options: { apiKey: string }): Promise<SdkModel[]> } };
  CursorAgentError?: new (...args: never[]) => Error;
  SqliteLocalAgentStore: { open(options: { workspaceRef: string; stateRoot: string }): Promise<unknown> };
}

export const CURSOR_ONLY_ID_PHRASE = "Responda só com um destes ids, sem editar arquivos.";
export const CURSOR_CORRECTIONS = 2;
export const CURSOR_SYSTEM_PROMPT = [
  "You are a chess move picker. You are not a coding assistant.",
  "Do not read files, edit files, run commands, search, or use tools.",
  "Do not mention code, repositories, or implementation.",
  "Play to win. Be effective and fast: decide quickly, do not deliberate at length.",
  "Do not explain, plan, or think aloud.",
  "Reply with exactly one move id from the user message and nothing else.",
  "Later messages in this game bring only the opponent's move, the new FEN and the legal moves.",
].join(" ");

export interface ListedModel {
  id: string;
  label: string;
  aliases: string[];
}

export interface CursorPromptResult {
  status: string;
  result?: string;
  durationMs?: number;
  model?: { id?: string };
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: { message?: string };
  getUsage?: () => Promise<{ cost?: { chargedCents?: number } }>;
  close?: () => void;
}

export interface CursorPromptOptions {
  apiKey?: string;
  model: { id: string; params?: ModelParameterValue[] };
  tools: [];
  local: { cwd: string; settingSources: []; enableAgentRetries: false };
}

type PromptFn = (prompt: string, options: CursorPromptOptions, conversation: string) => Promise<CursorPromptResult>;

/** Cache local do SDK: server/.cache/cursor (fora do git). */
export function cacheDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.cache/cursor");
}

type SdkImporter = () => Promise<CursorSdk>;

const importSdk: SdkImporter = async () => {
  const main = "@cursor/sdk";
  const sqlite = "@cursor/sdk/sqlite";
  const [core, store] = await Promise.all([import(main), import(sqlite)]);
  return { ...core, SqliteLocalAgentStore: store.SqliteLocalAgentStore } as CursorSdk;
};

let sdkPromise: Promise<CursorSdk | null> | undefined;

/** Carrega o SDK uma vez. Devolve null se não estiver instalado. */
export function loadCursorSdk(importer: SdkImporter = importSdk): Promise<CursorSdk | null> {
  if (!sdkPromise) sdkPromise = importer().then((sdk) => sdk, () => null);
  return sdkPromise;
}

/** Só para testes. */
export function resetCursorSdk(): void {
  sdkPromise = undefined;
}

async function requireSdk(): Promise<CursorSdk> {
  const sdk = await loadCursorSdk();
  if (!sdk) throw Object.assign(new Error("@cursor/sdk não instalado"), { name: "CursorAgentError" });
  return sdk;
}

export function conversationKey(sessionId: string, slot: Slot): string {
  return `${sessionId}:${slot}`;
}

export function buildCursorPrompt(context: DecisionContext): string {
  const ids = context.candidates.map((candidate) => candidate.id);
  return [
    CURSOR_SYSTEM_PROMPT,
    CURSOR_ONLY_ID_PHRASE,
    positionBrief(context),
    ...opponentLine(context),
    `FEN: ${context.fen}`,
    `Side to move: ${context.sideToMove === "w" ? "white" : "black"}`,
    `Game: ${context.sessionId}`,
    `Objective: ${context.objective}`,
    `ids: ${ids.join(", ")}`,
  ].join("\n");
}

export function buildCursorTurn(context: DecisionContext): string {
  return [
    ...opponentLine(context),
    sideLine(context),
    ...endingLines(context),
    `FEN: ${context.fen}`,
    `legal_moves: ${labeledMoves(context)}`,
    CURSOR_ONLY_ID_PHRASE,
  ].join("\n");
}

export function buildCursorCorrection(context: DecisionContext, answer: string): string {
  return [
    answer ? `"${answer}" is not in legal_moves. That move is illegal in this position.` : "Your reply was not a move id.",
    sideLine(context),
    `FEN: ${context.fen}`,
    `legal_moves: ${labeledMoves(context)}`,
    CURSOR_ONLY_ID_PHRASE,
  ].join("\n");
}

function sideLine(context: DecisionContext): string {
  return `You play ${context.sideToMove === "w" ? "white" : "black"}.`;
}


export function pickModelParams(parameters: ModelParameterDefinition[] = []): ModelParameterValue[] {
  const picked: ModelParameterValue[] = [];
  for (const parameter of parameters) {
    const values = parameter.values.map((item) => item.value);
    const value =
      parameter.id === "fast" ? (values.includes("true") ? "true" : null)
      : parameter.id === "reasoning_effort" || parameter.id === "effort" ? (values.includes("high") ? "high" : null)
      : parameter.id === "context" ? smallest(values)
      : null;
    if (value) picked.push({ id: parameter.id, value });
  }
  return picked;
}

export function cursorPromptOptions(deps: {
  apiKey?: string;
  modelId: string;
  cacheDir: string;
  params?: ModelParameterValue[];
}): CursorPromptOptions {
  return {
    apiKey: deps.apiKey,
    model: deps.params?.length ? { id: deps.modelId, params: deps.params } : { id: deps.modelId },
    tools: [],
    local: { cwd: deps.cacheDir, settingSources: [], enableAgentRetries: false },
  };
}

function opponentLine(context: DecisionContext): string[] {
  const move = context.lastMove;
  if (!move) return [];
  return [`Opponent played ${move.id}${move.san ? ` (${move.san})` : ""}.`];
}

function smallest(values: string[]): string | null {
  const size = (value: string) => parseFloat(value) * (/m$/i.test(value) ? 1000 : 1);
  const sized = values.filter((value) => Number.isFinite(size(value)));
  sized.sort((a, b) => size(a) - size(b));
  return sized[0] ?? null;
}

export function choiceFromText(text: string): string | null {
  const token = text.trim().split(/\s+/)[0]?.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "") ?? "";
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token) ? token : null;
}

export async function listCursorModels(deps: {
  apiKey: string | undefined;
  list: () => Promise<Array<{ id: string; displayName?: string; aliases?: string[] }>>;
}): Promise<{ models: ListedModel[]; error: string | null }> {
  if (!deps.apiKey) return { models: [], error: "credencial ausente" };
  try {
    const models = await deps.list();
    return {
      models: models.map((model) => ({
        id: model.id,
        label: model.displayName || model.id,
        aliases: model.aliases ?? [],
      })),
      error: null,
    };
  } catch {
    return { models: [], error: "Falha ao listar modelos do Cursor." };
  }
}

export async function askCursor(
  context: DecisionContext,
  deps: {
    apiKey: string | undefined;
    modelId: string;
    cacheDir: string;
    conversation?: string;
    timeoutMs?: number;
    budgetMs?: number | null;
    prompt?: PromptFn;
  },
): Promise<AdapterDecision> {
  const conversation = deps.conversation;
  const prompt = conversation && sent.has(conversation) ? buildCursorTurn(context) : buildCursorPrompt(context);
  if (!deps.modelId) return failed(prompt, "modelo ausente");
  if (!deps.apiKey) return failed(prompt, "credencial ausente");
  const deadline = deps.budgetMs != null ? performance.now() + deps.budgetMs : null;
  const limit = deadline == null ? CURSOR_CORRECTIONS : Infinity;
  const legal = new Set(context.candidates.map((candidate) => candidate.id));
  const preludes: ProviderAttempt[] = [];
  let decision = await askOnce(prompt, deps);
  for (
    let correction = 0;
    correction < limit && wrongMove(decision, legal) && (deadline == null || performance.now() < deadline);
    correction += 1
  ) {
    preludes.push(attemptOf(decision));
    decision = await askOnce(buildCursorCorrection(context, answerOf(decision)), deps);
  }
  return { ...decision, preludes };
}

function wrongMove(decision: AdapterDecision, legal: Set<string>): boolean {
  if (decision.failureReason === "resposta inválida") return true;
  return !decision.failureReason && decision.choiceId != null && !legal.has(decision.choiceId);
}

function answerOf(decision: AdapterDecision): string {
  const raw = decision.rawResponse as { result?: unknown } | null;
  const text = typeof raw?.result === "string" ? raw.result : decision.choiceId ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 40);
}

function attemptOf(decision: AdapterDecision): ProviderAttempt {
  return {
    logical: false,
    choiceId: decision.choiceId,
    durationMs: decision.durationMs,
    failureReason: decision.choiceId ? "id fora da lista" : "resposta inválida",
    modelReturned: decision.modelReturned,
    inputTokens: decision.inputTokens,
    outputTokens: decision.outputTokens,
    costUsd: decision.costUsd,
    costNature: decision.costNature,
    rawResponse: decision.rawResponse,
  };
}

async function askOnce(
  prompt: string,
  deps: { apiKey: string | undefined; modelId: string; cacheDir: string; conversation?: string; timeoutMs?: number; prompt?: PromptFn },
): Promise<AdapterDecision> {
  const conversation = deps.conversation;
  const options = cursorPromptOptions(deps);
  const started = performance.now();
  let closer: (() => void) | undefined;
  try {
    const key = conversation ?? deps.modelId;
    const pending = deps.prompt ? deps.prompt(prompt, options, key) : realPrompt(prompt, options, key);
    const result = deps.timeoutMs != null ? await withTimeout(pending, deps.timeoutMs) : await pending;
    if (conversation) sent.add(conversation);
    closer = result.close;
    const durationMs = Math.round(performance.now() - started);
    if (result.status === "error" || result.status === "cancelled") {
      const usage = readUsage(result.usage);
      const detail = publicDetail(result.error?.message);
      return {
        ...failed(prompt, detail ? `execução com erro. ${detail}` : "execução com erro", durationMs, { status: result.status }, result.durationMs),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    }
    const choiceId = singleToken(result.result ?? "");
    const cost = await readCost(result);
    const usage = readUsage(result.usage);
    return {
      choiceId,
      modelReturned: result.model?.id ?? null,
      rawResponse: { status: result.status, result: result.result ?? "", model: result.model?.id ?? null },
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: cost.costUsd,
      costNature: cost.costNature,
      sdkDurationMs: typeof result.durationMs === "number" ? result.durationMs : null,
      durationMs,
      failureReason: choiceId ? null : "resposta inválida",
      confidence: null,
      distribution: null,
      prompt,
      preludes: [],
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    if (isTimeout(error)) return failed(prompt, "tempo esgotado", durationMs);
    if (isStartup(error)) return failed(prompt, "falha de início", durationMs);
    return failed(prompt, "falha de rede", durationMs);
  } finally {
    closer?.();
  }
}

const agents = new Map<string, SDKAgent>();
const gates = new Map<string, Promise<void>>();
const sent = new Set<string>();
let storePromise: Promise<unknown> | undefined;
let paramsPromise: Promise<Map<string, ModelParameterValue[]>> | undefined;

function localStore(sdk: CursorSdk, cwd: string): Promise<unknown> {
  if (!storePromise) {
    const stateRoot = path.join(cwd, "sdk");
    mkdirSync(stateRoot, { recursive: true });
    storePromise = sdk.SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot });
  }
  return storePromise;
}

function modelParams(modelId: string, apiKey: string): Promise<ModelParameterValue[]> {
  if (!paramsPromise) {
    paramsPromise = requireSdk().then((sdk) => sdk.Cursor.models.list({ apiKey })).then(
      (models) => new Map(models.map((model) => [model.id, pickModelParams(model.parameters)])),
      () => {
        paramsPromise = undefined;
        return new Map();
      },
    );
  }
  return paramsPromise.then((byModel) => byModel.get(modelId) ?? []);
}

export function forgetCursor(): void {
  for (const conversation of [...agents.keys()]) dropAgent(conversation);
  sent.clear();
}

export function warmCursor(conversation: string, modelId: string, apiKey: string | undefined): void {
  if (!apiKey || !modelId) return;
  void withAgent(conversation, apiKey, optionsFor(modelId, apiKey), async () => undefined).catch(() => undefined);
}

async function realPrompt(message: string, options: CursorPromptOptions, conversation: string): Promise<CursorPromptResult> {
  mkdirSync(options.local.cwd, { recursive: true });
  const apiKey = options.apiKey ?? "";
  try {
    return await withAgent(conversation, apiKey, options, (agent) => sendOnce(agent, message));
  } catch (error) {
    const sdk = await loadCursorSdk();
    if (isStartup(error) || (sdk?.CursorAgentError != null && error instanceof sdk.CursorAgentError)) {
      const startup = new Error((error as Error).message);
      startup.name = "CursorAgentError";
      throw startup;
    }
    throw error;
  }
}

async function sendOnce(agent: SDKAgent, message: string): Promise<CursorPromptResult> {
  const run = await agent.send(message);
  const result = await run.wait();
  return {
    status: result.status,
    result: result.result,
    durationMs: result.durationMs,
    model: result.model,
    usage: result.usage,
    error: result.error,
  };
}

function optionsFor(modelId: string, apiKey: string): CursorPromptOptions {
  return cursorPromptOptions({ apiKey, modelId, cacheDir: cacheDir() });
}

async function withAgent<T>(
  conversation: string,
  apiKey: string,
  options: CursorPromptOptions,
  fn: (agent: SDKAgent) => Promise<T>,
): Promise<T> {
  const previous = gates.get(conversation) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  gates.set(conversation, previous.then(() => gate));
  await previous;
  try {
    const agent = agents.get(conversation) ?? await openAgent(conversation, apiKey, options);
    return await fn(agent);
  } finally {
    release();
  }
}

async function openAgent(conversation: string, apiKey: string, options: CursorPromptOptions): Promise<SDKAgent> {
  const sdk = await requireSdk();
  const store = await localStore(sdk, options.local.cwd);
  const params = options.model.params ?? await modelParams(options.model.id, apiKey);
  const agent = await sdk.Agent.create({
    apiKey,
    model: params.length ? { id: options.model.id, params } : { id: options.model.id },
    tools: [],
    local: {
      cwd: options.local.cwd,
      settingSources: [],
      enableAgentRetries: false,
      store,
    },
  });
  agents.set(conversation, agent);
  return agent;
}

function dropAgent(conversation: string): void {
  const agent = agents.get(conversation);
  agents.delete(conversation);
  gates.delete(conversation);
  agent?.close();
}

function publicDetail(text: string | undefined): string | null {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!compact || /authorization|bearer|api[_ -]?key|secret/i.test(compact)) return null;
  return compact.slice(0, 180);
}

function singleToken(text: string): string | null {
  const trimmed = text.replace(/<\|[^|>]*\|?>/g, "").trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return trimmed.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "") || null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { timeout: true })), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readCost(result: CursorPromptResult): Promise<{ costUsd: number | null; costNature: CostNature }> {
  if (!result.getUsage) return { costUsd: null, costNature: "unavailable" };
  try {
    const usage = await result.getUsage();
    return cursorCost(usage.cost);
  } catch {
    return { costUsd: null, costNature: "unavailable" };
  }
}

function readUsage(usage: CursorPromptResult["usage"]): { inputTokens: number | null; outputTokens: number | null } {
  if (!usage) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
    outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
  };
}

function failed(
  prompt: string,
  failureReason: string,
  durationMs: number | null = null,
  rawResponse: unknown = null,
  sdkDurationMs: number | null = null,
): AdapterDecision {
  return {
    choiceId: null,
    modelReturned: null,
    rawResponse,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    sdkDurationMs,
    durationMs,
    failureReason,
    confidence: null,
    distribution: null,
    prompt,
    preludes: [],
  };
}

function isStartup(error: unknown): boolean {
  return error instanceof Error && error.name === "CursorAgentError";
}

function isTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "timeout" in error);
}

export interface CursorProviderDeps {
  env?: Record<string, string | undefined>;
  loadSdk?: () => Promise<CursorSdk | null>;
}

const MODELS_TTL_MS = 5 * 60_000;

export function createCursorProvider(deps: CursorProviderDeps = {}): ProviderModule {
  const env = deps.env ?? process.env;
  const load = deps.loadSdk ?? (() => loadCursorSdk());
  let cached: { at: number; models: ModelOption[] } | null = null;

  return {
    id: "cursor",
    label: "Cursor SDK",
    kind: "sdk",
    async status() {
      if (!env.CURSOR_API_KEY) return { available: false, reason: "CURSOR_API_KEY ausente" };
      const sdk = await load();
      if (!sdk) return { available: false, reason: "@cursor/sdk não instalado (dependência opcional)" };
      return { available: true, reason: null };
    },
    async models() {
      const apiKey = env.CURSOR_API_KEY;
      const sdk = apiKey ? await load() : null;
      if (!apiKey || !sdk) return [];
      if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
      const listed = await listCursorModels({
        apiKey,
        list: async () => (await sdk.Cursor.models.list({ apiKey })).map((model) => ({
          id: model.id,
          displayName: model.displayName,
          aliases: model.aliases,
        })),
      });
      const models = listed.models.map((model) => ({ id: model.id, label: model.label }));
      if (!listed.error) cached = { at: Date.now(), models };
      return models;
    },
    decide(request) {
      return askCursor(request.context, {
        apiKey: env.CURSOR_API_KEY,
        modelId: request.participant.modelId,
        cacheDir: cacheDir(),
        conversation: conversationKey(request.sessionId, request.slot),
        budgetMs: request.budgetMs ?? null,
      });
    },
    openSession(session) {
      forgetCursor();
      for (const participant of session.participants) {
        if (participant.provider === "cursor") {
          warmCursor(conversationKey(session.sessionId, participant.slot), participant.modelId, env.CURSOR_API_KEY);
        }
      }
    },
    closeAll() {
      forgetCursor();
    },
  };
}
