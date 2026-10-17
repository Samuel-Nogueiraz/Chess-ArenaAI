import { Chess } from "chess.js";
import { jevCost } from "./cost.js";
import { matingMoves, uciOf } from "./engine.js";
import { PIECE_VALUE, searchRoot } from "./heuristic-engine.js";
import { buildMovePrompt } from "./prompt.js";
import type { AdapterDecision, AdapterRequest, CostNature, DecisionAdapter, DecisionContext } from "./types.js";

export const DEMO_PROVIDER_LABEL = "Demo · simulado";

export type DemoModelId = "jev-demo" | "rival-greedy" | "rival-random";

interface DemoModelSpec {
  id: DemoModelId;
  label: string;
  latencyMs: readonly [number, number];
  /** Tarifa ilustrativa em US$ por milhão de tokens. Não é preço de ninguém. */
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

const SPECS: readonly DemoModelSpec[] = [
  { id: "jev-demo", label: "JEV · simulado", latencyMs: [250, 700], inputUsdPerMillion: 0.042, outputUsdPerMillion: 0 },
  { id: "rival-greedy", label: "Rival guloso · simulado", latencyMs: [600, 1800], inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
  { id: "rival-random", label: "Rival aleatório · simulado", latencyMs: [600, 1800], inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
];

/** Modelos do provedor demo, na ordem em que a interface mostra. */
export const DEMO_MODELS: ReadonlyArray<{ id: DemoModelId; label: string }> = SPECS.map(({ id, label }) => ({ id, label }));

export function isDemoModelId(value: string): value is DemoModelId {
  return SPECS.some((spec) => spec.id === value);
}

export interface DemoOptions {
  /**
   * Fator sobre a latência simulada: 1 espera o tempo real do modelo, 0.25 espera um quarto,
   * 0 não espera. Padrão 1.
   */
  speed?: number;
}

export type Rng = () => number;

/** PRNG determinístico (mulberry32) semeado por uma string (FNV-1a). */
export function createRng(seed: string): Rng {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Meio-lance da posição (0 = primeiro lance das brancas), lido do próprio FEN. */
export function plyOf(fen: string): number {
  const parts = fen.split(" ");
  const full = Number(parts[5]);
  const turn = parts[1] === "b" ? 1 : 0;
  return (Number.isFinite(full) && full >= 1 ? full - 1 : 0) * 2 + turn;
}

export function createDemoAdapter(options: DemoOptions = {}): DecisionAdapter {
  const speed = Math.max(0, options.speed ?? 1);
  return {
    async decide(request: AdapterRequest): Promise<AdapterDecision> {
      const { context } = request;
      const prompt = buildMovePrompt(context);
      const spec = SPECS.find((item) => item.id === request.participant.modelId);
      if (!spec) return failed(prompt, "modelo demo desconhecido");

      const rng = createRng(`${request.sessionId}:${plyOf(context.fen)}:${request.slot}:${spec.id}`);
      const choiceId = choose(spec.id, context, rng);
      const latency = Math.round((spec.latencyMs[0] + rng() * (spec.latencyMs[1] - spec.latencyMs[0])) * speed);
      const outputTokens = 2 + Math.floor(rng() * 5);
      const inputTokens = Math.ceil(prompt.length / 4);

      const budget = request.budgetMs ?? null;
      const overrun = budget != null && latency >= budget;
      const waited = overrun ? Math.max(0, budget) : latency;
      if (waited > 0) await new Promise<void>((resolve) => setTimeout(resolve, waited));
      if (overrun) return { ...failed(prompt, "relógio esgotado"), durationMs: waited, choiceId };
      if (choiceId == null) return { ...failed(prompt, "sem lances legais"), durationMs: waited };

      const cost = costOf(spec, inputTokens, outputTokens);
      return {
        choiceId,
        modelReturned: spec.id,
        rawResponse: { simulated: true, model: spec.id, choice: choiceId },
        inputTokens,
        outputTokens,
        costUsd: cost.costUsd,
        costNature: cost.costNature,
        sdkDurationMs: null,
        durationMs: waited,
        failureReason: null,
        confidence: null,
        distribution: null,
        prompt,
        preludes: [],
      };
    },
  };
}

function costOf(spec: DemoModelSpec, inputTokens: number, outputTokens: number): { costUsd: number; costNature: CostNature } {
  if (spec.id === "jev-demo") {
    const jev = jevCost(inputTokens);
    return { costUsd: jev.costUsd ?? 0, costNature: "estimated" };
  }
  return {
    costUsd: (inputTokens / 1_000_000) * spec.inputUsdPerMillion + (outputTokens / 1_000_000) * spec.outputUsdPerMillion,
    costNature: "estimated",
  };
}

function choose(model: DemoModelId, context: DecisionContext, rng: Rng): string | null {
  const legal = context.candidates.map((candidate) => candidate.id);
  if (legal.length === 0) return null;
  const only = (ids: string[]) => ids.filter((id) => legal.includes(id));
  if (model === "rival-random") return pick(legal, rng);
  if (model === "rival-greedy") return greedy(context.fen, legal, rng);

  const mates = only(matingMoves(context.fen).map((move) => move.id));
  if (mates.length > 0) return pick(mates, rng);
  const best = only(searchRoot(context.fen, 2).best.map((move) => move.uci));
  return pick(best.length > 0 ? best : legal, rng);
}

function greedy(fen: string, legal: string[], rng: Rng): string {
  let top = 0;
  let captures: string[] = [];
  for (const move of new Chess(fen).moves({ verbose: true })) {
    const id = uciOf(move);
    if (!move.captured || !legal.includes(id)) continue;
    const value = PIECE_VALUE[move.captured] ?? 0;
    if (value > top) {
      top = value;
      captures = [id];
    } else if (value === top) {
      captures.push(id);
    }
  }
  return pick(captures.length > 0 ? captures : legal, rng);
}

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))] as T;
}

function failed(prompt: string, failureReason: string): AdapterDecision {
  return {
    choiceId: null,
    modelReturned: null,
    rawResponse: { simulated: true },
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    sdkDurationMs: null,
    durationMs: null,
    failureReason,
    confidence: null,
    distribution: null,
    prompt,
    preludes: [],
  };
}
