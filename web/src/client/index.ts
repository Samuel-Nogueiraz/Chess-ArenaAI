import type { ArenaClient } from "./types";

export { ApiError } from "./types";
export type { ArenaClient, ClientAction, CreateSessionRequest, DecideParse } from "./types";

let pending: Promise<ArenaClient> | null = null;

async function pick(): Promise<ArenaClient> {
  // Com VITE_ARENA_MODE=demo o Vite troca a comparação por uma constante e descarta o resto:
  // o cliente HTTP e as rotas do servidor nem entram no pacote.
  if (import.meta.env.VITE_ARENA_MODE === "demo") {
    const { createDemoClient } = await import("./demo");
    return createDemoClient();
  }
  const { probeHealth, createHttpClient } = await import("./http");
  if (await probeHealth()) return createHttpClient();
  const { createDemoClient } = await import("./demo");
  return createDemoClient();
}

/** Escolhe o cliente uma vez por página: demo forçada pelo build, senão servidor local se responder, senão demo. */
export function getArenaClient(): Promise<ArenaClient> {
  pending ??= pick();
  return pending;
}
