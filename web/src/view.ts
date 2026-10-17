import type { Candidate, HistoryEntry, Outcome, ParticipantConfig, ProviderId, SessionSnapshot, Slot } from "./types";

export const SCENARIOS = [
  { id: "game", label: "Partida" },
  { id: "opening", label: "Abertura de exemplo" },
  { id: "mate", label: "Mate em um lance" },
  { id: "check", label: "Saída obrigatória de xeque" },
  { id: "defense", label: "Defesa do rei" },
] as const;

export function scenarioLabel(id: string): string {
  return SCENARIOS.find((item) => item.id === id)?.label ?? id;
}

export function slotTitle(slot: Slot, battle: boolean): string {
  if (!battle) return slot === 0 ? "Participante 1" : "Participante 2";
  return slot === 0 ? "Participante 1, brancas" : "Participante 2, pretas";
}

export function entryProvider(entry: HistoryEntry, participants: ParticipantConfig[]): ProviderId | null {
  if (entry.provider) return entry.provider;
  return participants.find((item) => item.slot === entry.slot)?.provider ?? null;
}

/** Id do modelo JEV simulado do provedor demo (o mesmo que o núcleo conta no custo JEV). */
export const DEMO_JEV_MODEL_ID = "jev-demo";

export function isJevModel(provider: ProviderId | null, modelId: string): boolean {
  return provider === "jev" || (provider === "demo" && modelId === DEMO_JEV_MODEL_ID);
}

export function isJevEntry(entry: HistoryEntry, participants: ParticipantConfig[]): boolean {
  return isJevModel(entryProvider(entry, participants), entry.modelRequested);
}

export function isJevParticipant(participant: ParticipantConfig): boolean {
  return isJevModel(participant.provider, participant.modelId);
}

/** Simulado: a entrada diz que é demo, ou (sem entrada) o participante é do provedor demo. */
export function isSimulated(entry: HistoryEntry | null, participant?: ParticipantConfig | null): boolean {
  if (entry) return entry.mode === "demo" || (entry.mode == null && entry.provider === "demo");
  return participant?.provider === "demo";
}

export function latestFor(history: HistoryEntry[], slot: Slot): HistoryEntry | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.slot === slot) return history[index] ?? null;
  }
  return null;
}

export function lastAppliedChoice(history: HistoryEntry[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.validation === "aceita" && entry.choiceId && entry.applied !== false) return entry.choiceId;
  }
  return null;
}

export function displayMove(entry: HistoryEntry | null, session: SessionSnapshot | null): string {
  if (!entry) return "Sem chamada.";
  if (entry.san) return entry.san;
  if (entry.choiceId && session && (session.mode === "compare" || entry.fen === session.fen)) {
    const found = session.candidates.find((candidate: Candidate) => candidate.id === entry.choiceId);
    if (found && found.san !== found.id) return found.san;
  }
  return entry.choiceId ?? "Indisponível";
}

export function failureNote(entry: HistoryEntry): string {
  if (entry.validation === "recusada") {
    return entry.failureReason ? `Recusa. ${entry.failureReason}` : "Recusa. O lance não entra no tabuleiro.";
  }
  return entry.failureReason ? `Falha. ${entry.failureReason}` : "Falha na decisão.";
}

export function costNote(entry: HistoryEntry, provider: ProviderId | null): string | null {
  if (entry.costNature === "included") return "Custo incluso no plano. Fora da soma em dólar.";
  const absent = entry.costNature === "unavailable" || typeof entry.costUsd !== "number";
  if (!absent) return entry.mode === "demo" ? "Custo simulado: tarifa ilustrativa, não é fatura." : null;
  return provider === "cursor" ? "Custo indisponível no Cursor." : "Custo indisponível.";
}

export function modelLabel(modelId: string, labelById: Map<string, string>): string {
  if (!modelId) return "Sem modelo";
  return labelById.get(modelId) ?? modelId;
}

export function victoryLine(
  outcome: Outcome | null | undefined,
  participants: ParticipantConfig[],
  labels: Map<string, string>,
): string | null {
  if (!outcome || (outcome.kind !== "checkmate" && outcome.kind !== "timeout") || outcome.winnerSlot == null) return null;
  const config = participants.find((item) => item.slot === outcome.winnerSlot);
  const name = config ? modelLabel(config.modelId, labels) : "Sem modelo";
  return `Vitória de ${name}`;
}
