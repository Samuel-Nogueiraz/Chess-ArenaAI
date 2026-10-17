import type { HistoryEntry, ParticipantConfig, SessionSnapshot, Slot } from "../types";
import { formatClock, formatCost, formatCount, formatDuration, providerLabel } from "../format";
import { displayMove, entryProvider, isSimulated, slotTitle } from "../view";
import { SimTag } from "./SimTag";
import { MetricList } from "./MetricList";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface ParticipantBlockProps {
  slot: Slot;
  battle: boolean;
  model: string;
  session: SessionSnapshot | null;
  entry: HistoryEntry | null;
  participants: ParticipantConfig[];
  active: boolean;
  consulting: boolean;
  clockMs?: number | null;
  compact?: boolean;
  onSelect: () => void;
}

const LOW_CLOCK_MS = 30_000;

export function ParticipantBlock({
  slot,
  battle,
  model,
  session,
  entry,
  participants,
  active,
  consulting,
  clockMs = null,
  compact = false,
  onSelect,
}: ParticipantBlockProps) {
  const provider = entry ? entryProvider(entry, participants) : participants.find((item) => item.slot === slot)?.provider ?? null;
  const pending = consulting ? "Consultando." : !entry ? "Sem chamada." : null;
  const showClock = battle && clockMs != null;
  const side = battle ? (slot === 0 ? "side-w" : "side-b") : "side-n";
  const classes = ["block", "fighter", side, active ? "active" : "", consulting ? "consulting" : ""].filter(Boolean).join(" ");
  return (
    <article className={classes}>
      <header className="fighter-head">
        {battle ? <span className="seat" aria-hidden="true" /> : <span className="seat-num" aria-hidden="true">{slot + 1}</span>}
        <h3>{slotTitle(slot, battle)}</h3>
        {consulting ? (
          <ThinkingIndicator />
        ) : active && battle ? (
          <span className="turn">na vez</span>
        ) : null}
      </header>
      <button type="button" className="who-btn" onClick={onSelect}>
        <span className="who">{model}</span>
        <span className="origin">
          {providerLabel(provider)}
          {isSimulated(entry, participants.find((item) => item.slot === slot)) ? <> <SimTag /></> : null}
        </span>
        {active && !battle ? <span className="chip on">Escolha visível</span> : null}
      </button>
      {showClock ? (
        <p className={`clock mono${clockMs < LOW_CLOCK_MS ? " low" : ""}`} aria-label="Relógio">
          {formatClock(clockMs)}
        </p>
      ) : null}
      <MetricList
        rows={
          compact
            ? [
                { label: "Lance", value: pending ?? displayMove(entry, session) },
                { label: "Tempo", value: pending ?? formatDuration(entry?.durationMs) },
              ]
            : [
                { label: "Lance", value: pending ?? displayMove(entry, session) },
                { label: "Duração de relógio", value: pending ?? formatDuration(entry?.durationMs) },
                { label: "Tokens de entrada", value: pending ?? formatCount(entry?.inputTokens) },
                { label: "Tokens de saída", value: pending ?? formatCount(entry?.outputTokens) },
                { label: "Custo", value: pending ?? formatCost(entry?.costUsd, entry?.costNature, provider) },
              ]
        }
      />
    </article>
  );
}
