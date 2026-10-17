import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  analyzeGame,
  createSessionStore,
  isProviderId,
  isScenarioId,
  SessionError,
  type CreateSessionInput,
  type Engine,
  type GameAnalysis,
  type Mode,
  type Participant,
  type PublicSession,
  type ScenarioId,
  type SessionStore,
  type Slot,
} from "@arena/core";
import type { Registry } from "./providers/registry.js";
import { isLoopback } from "./env.js";
import { createStaticHandler, type StaticHandler } from "./static.js";
import { createStockfish } from "./stockfish.js";

interface Analyzer {
  analyze(session: PublicSession): Promise<GameAnalysis>;
}

export interface AppOptions {
  registry: Registry;
  /** Motor da análise. Padrão: Stockfish (sobe só no primeiro uso). */
  engine?: Engine;
  /** Pasta compilada da web. Sem ela, só a API responde. */
  staticDir?: string | null;
  version?: string;
  /** Recusa Host/Origin que não sejam da própria máquina (defesa contra DNS rebinding e CSRF). Padrão: true. */
  localOnly?: boolean;
}

export function createApp(options: AppOptions) {
  const store = createSessionStore(options.registry);
  const engine = options.engine ?? createStockfish();
  const analyzer = createAnalyzer(engine);
  const serveStatic = options.staticDir ? createStaticHandler(options.staticDir) : null;
  const context: Context = {
    store,
    analyzer,
    registry: options.registry,
    serveStatic,
    version: options.version ?? "0.0.0",
    localOnly: options.localOnly ?? true,
  };

  const server = createServer((req, res) => {
    void handle(context, req, res).catch((error: unknown) => {
      const status = error instanceof SessionError ? error.status : 400;
      const message = error instanceof Error ? error.message : "Falha.";
      send(res, status, { error: message });
    });
  });

  return {
    server,
    store,
    registry: options.registry,
    close() {
      options.registry.closeAll();
      (engine as Engine & { close?: () => void }).close?.();
    },
  };
}

interface Context {
  store: SessionStore;
  analyzer: Analyzer;
  registry: Registry;
  serveStatic: StaticHandler | null;
  version: string;
  localOnly: boolean;
}

function createAnalyzer(engine: Engine): Analyzer {
  const cache = new Map<string, Promise<GameAnalysis>>();
  return {
    analyze(session) {
      const key = `${session.sessionId}:${session.history.length}:${session.outcome?.kind ?? "aberta"}`;
      const cached = cache.get(key);
      if (cached) return cached;
      if (cache.size >= 20) cache.clear();
      const job = analyzeGame(session, engine);
      cache.set(key, job);
      job.catch(() => cache.delete(key));
      return job;
    },
  };
}

function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0] ?? "";
}

function originAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host || !isLoopback(hostnameOf(host))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return isLoopback(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse) {
  if (ctx.localOnly && !originAllowed(req)) {
    send(res, 403, { error: "Origem não permitida." });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/health") {
    send(res, 200, { ok: true, mode: "live", version: ctx.version });
    return;
  }
  if (req.method === "GET" && path === "/api/providers") {
    send(res, 200, { providers: await ctx.registry.list() });
    return;
  }
  if (req.method === "POST" && path === "/api/sessions") {
    const input = await readCreate(req);
    await ctx.registry.assertUsable(input.participants);
    const created = ctx.store.create(input);
    ctx.registry.openSession(created);
    send(res, 201, created);
    return;
  }

  if (!path.startsWith("/api/")) {
    if (ctx.serveStatic) {
      await ctx.serveStatic(req, res, path);
      return;
    }
    send(res, 404, { error: "Rota não encontrada." });
    return;
  }

  const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    send(res, 404, { error: "Rota não encontrada." });
    return;
  }
  const sessionId = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  const { store } = ctx;
  if (req.method === "GET" && !action) {
    send(res, 200, store.get(sessionId));
    return;
  }
  if (req.method === "GET" && action === "export") {
    send(res, 200, store.exportSession(sessionId));
    return;
  }
  if (req.method === "GET" && action === "analysis") {
    const session = store.get(sessionId);
    try {
      send(res, 200, await ctx.analyzer.analyze(session));
    } catch (error) {
      send(res, 503, { error: error instanceof Error ? error.message : "Análise indisponível." });
    }
    return;
  }
  if (req.method === "POST" && action === "decide") {
    const body = await readJson(req);
    const slot = isRecord(body) ? body.slot : undefined;
    if (slot !== 0 && slot !== 1) throw new SessionError("Slot inválido.");
    const injected = isRecord(body) && typeof body.injectedChoiceId === "string" ? body.injectedChoiceId : undefined;
    send(res, 200, await store.decide(sessionId, slot, injected));
    return;
  }
  if (req.method === "POST" && action === "pause") {
    send(res, 200, store.pause(sessionId));
    return;
  }
  if (req.method === "POST" && action === "resume") {
    send(res, 200, store.resume(sessionId));
    return;
  }
  if (req.method === "POST" && action === "stop") {
    send(res, 200, store.stop(sessionId));
    return;
  }
  if (req.method === "POST" && action === "restart") {
    const restarted = store.restart(sessionId);
    ctx.registry.openSession(restarted);
    send(res, 200, restarted);
    return;
  }
  send(res, 404, { error: "Rota não encontrada." });
}

async function readCreate(req: IncomingMessage): Promise<CreateSessionInput> {
  const body = await readJson(req);
  if (!isRecord(body)) throw new SessionError("Pedido inválido.");
  const mode = body.mode === "compare" || body.mode === "battle" ? body.mode : null;
  const scenarioId = typeof body.scenarioId === "string" && isScenarioId(body.scenarioId) ? body.scenarioId : null;
  if (!mode || !scenarioId) throw new SessionError("Pedido inválido.");
  if (!Array.isArray(body.participants)) throw new SessionError("Pedido inválido.");
  const participants = body.participants.map((item): Participant => {
    if (!isRecord(item)) throw new SessionError("Participante inválido.");
    const slot: Slot | null = item.slot === 0 || item.slot === 1 ? item.slot : null;
    const provider = isProviderId(item.provider) ? item.provider : null;
    const modelId = typeof item.modelId === "string" ? item.modelId : null;
    if (slot == null || !provider || modelId == null) throw new SessionError("Participante inválido.");
    return { slot, provider, modelId };
  });
  return { mode: mode as Mode, scenarioId: scenarioId as ScenarioId, participants };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new SessionError("Corpo grande demais."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new SessionError("JSON inválido."));
      }
    });
    req.on("error", () => reject(new SessionError("Falha ao ler o pedido.")));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}
