import type { DecideParse } from "../parse";
import type {
  ArenaMode,
  GameAnalysis,
  ParticipantConfig,
  ProvidersResponse,
  ScenarioId,
  SessionSnapshot,
} from "../types";

export type { DecideParse };

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type ClientAction = "pause" | "resume" | "stop" | "restart";

export interface CreateSessionRequest {
  mode: ArenaMode;
  scenarioId: ScenarioId;
  participants: ParticipantConfig[];
}

/** Contrato único da web com a arena: HTTP no modo local, núcleo no navegador no modo demo. */
export interface ArenaClient {
  mode: "demo" | "live";
  providers(): Promise<ProvidersResponse>;
  createSession(input: CreateSessionRequest): Promise<SessionSnapshot>;
  getSession(id: string): Promise<SessionSnapshot>;
  decide(id: string, slot: 0 | 1): Promise<DecideParse>;
  action(id: string, action: ClientAction): Promise<SessionSnapshot>;
  exportSession(id: string): Promise<unknown>;
  analysis(id: string): Promise<GameAnalysis>;
}
