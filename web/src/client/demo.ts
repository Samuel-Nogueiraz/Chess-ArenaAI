import {
  analyzeGame,
  createDemoAdapter,
  createHeuristicEngine,
  createSessionStore,
  DEMO_MODELS,
  DEMO_PROVIDER_LABEL,
  SessionError,
} from "@arena/core";
import { parseAnalysis, parseDecide, parseProviders, parseSession } from "../parse";
import { ApiError, type ArenaClient, type ClientAction, type CreateSessionRequest } from "./types";

/** Copia como se tivesse atravessado a rede: só JSON, sem referência ao estado do núcleo. */
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof SessionError) return new ApiError(error.message, error.status);
  return new ApiError(error instanceof Error && error.message ? error.message : "Falha.", 500);
}

/** Cede a thread antes de cada chamada e nunca deixa duas rodarem juntas (o jev-demo busca em profundidade). */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T> | T): Promise<T> => {
    const run = tail
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(job);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createDemoClient(): ArenaClient {
  const store = createSessionStore(createDemoAdapter());
  const engine = createHeuristicEngine();
  const queue = serial();

  const guard = async <T>(job: () => Promise<T> | T, serialize = false): Promise<T> => {
    try {
      return await (serialize ? queue(job) : job());
    } catch (error) {
      throw toApiError(error);
    }
  };

  return {
    mode: "demo",
    providers: () =>
      guard(() =>
        parseProviders(
          wire({
            providers: [
              {
                id: "demo",
                label: DEMO_PROVIDER_LABEL,
                kind: "demo",
                available: true,
                reason: null,
                models: DEMO_MODELS,
              },
            ],
          }),
        ),
      ),
    createSession: (input: CreateSessionRequest) =>
      guard(() =>
        parseSession(
          wire(
            store.create({
              mode: input.mode,
              scenarioId: input.scenarioId,
              participants: input.participants.map((participant) => ({
                slot: participant.slot,
                provider: participant.provider,
                modelId: participant.modelId,
              })),
            }),
          ),
        ),
      ),
    getSession: (id) => guard(() => parseSession(wire(store.get(id)))),
    decide: (id, slot) => guard(async () => parseDecide(wire(await store.decide(id, slot)), id), true),
    action: (id, action: ClientAction) => guard(() => parseSession(wire(store[action](id)))),
    exportSession: (id) => guard(() => wire(store.exportSession(id))),
    analysis: (id) => guard(async () => parseAnalysis(wire(await analyzeGame(store.get(id), engine))), true),
  };
}
