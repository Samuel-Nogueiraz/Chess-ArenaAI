import { parseAnalysis, parseDecide, parseProviders, parseSession } from "../parse";
import { ApiError, type ArenaClient, type ClientAction, type CreateSessionRequest } from "./types";

const SECRET_KEY =
  /^(authorization|proxy-authorization|api[-_]?key|x-api-key|secret|password|access[-_]?token|refresh[-_]?token|typesafe[-_]?api[-_]?key|cursor[-_]?api[-_]?key)$/i;

export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^bearer\s+\S+/i.test(value)) return "[omitido]";
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(inner);
  }
  return out;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(data: unknown): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  }
  return "Falha de ligação.";
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("Falha de ligação.", 0);
  }
  const data = await readBody(response);
  if (!response.ok) throw new ApiError(errorMessage(data), response.status);
  return data;
}

const HEALTH_TIMEOUT_MS = 1200;

/** O servidor local responde? Qualquer outra coisa (404, HTML do SPA, rede, tempo) vale como não. */
export async function probeHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch("/api/health", { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) return false;
    const data = await readBody(response);
    return typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

export function createHttpClient(): ArenaClient {
  return {
    mode: "live",
    providers: () => request("/api/providers").then(parseProviders),
    createSession: (input: CreateSessionRequest) =>
      request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          mode: input.mode,
          scenarioId: input.scenarioId,
          participants: input.participants.map((participant) => ({
            slot: participant.slot,
            provider: participant.provider,
            modelId: participant.modelId,
          })),
        }),
      }).then(parseSession),
    getSession: (id) => request(sessionPath(id)).then(parseSession),
    decide: (id, slot) =>
      request(`${sessionPath(id)}/decide`, { method: "POST", body: JSON.stringify({ slot }) }).then((data) =>
        parseDecide(data, id),
      ),
    action: (id, action: ClientAction) => request(`${sessionPath(id)}/${action}`, { method: "POST" }).then(parseSession),
    exportSession: async (id) => stripSecrets(await request(`${sessionPath(id)}/export`)),
    analysis: (id) => request(`${sessionPath(id)}/analysis`).then(parseAnalysis),
  };
}
