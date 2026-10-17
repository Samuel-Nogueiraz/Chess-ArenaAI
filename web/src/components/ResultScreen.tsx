import type { HistoryEntry, Outcome, ParticipantConfig, SessionSnapshot, Slot } from "../types";
import {
  formatClock,
  formatCostTotal,
  formatCount,
  formatDuration,
  providerLabel,
  summarizeCost,
  summarizeDurations,
  summarizeNumbers,
} from "../format";
import { displayMove, entryProvider, isJevEntry, isJevParticipant, isSimulated, modelLabel, slotTitle, victoryLine } from "../view";
import { AnalysisPanel, type AnalysisState } from "./AnalysisPanel";
import { MetricList } from "./MetricList";
import { SimTag } from "./SimTag";

interface ResultScreenProps {
  session: SessionSnapshot | null;
  participants: ParticipantConfig[];
  labels: Map<string, string>;
  analysis: AnalysisState;
  manualStop: boolean;
  onBack: () => void;
  onRestart: () => void;
  onExport: () => void;
  busy: boolean;
}

function callsFor(history: HistoryEntry[], slot: Slot): HistoryEntry[] {
  return history.filter((entry) => entry.slot === slot);
}

export function resultOutcome(session: SessionSnapshot | null, manualStop: boolean): Outcome | null {
  if (session?.outcome) return session.outcome;
  if (manualStop) {
    return { kind: "stopped", label: "Interrompida · sem vencedor", winnerSlot: null, san: null, reason: null };
  }
  return null;
}

export function resultCopy(
  session: SessionSnapshot | null,
  manualStop: boolean,
  participants: ParticipantConfig[],
  labels: Map<string, string>,
): { title: string; note: string } {
  if (session?.mode === "compare") {
    return { title: "Resultado da comparação", note: "Mesma posição. Sem vencedor." };
  }
  const outcome = resultOutcome(session, manualStop);
  if (!outcome) return { title: "Resultado", note: "Sem desfecho nesta sessão." };
  if (outcome.kind === "stopped") return { title: "Interrompida · sem vencedor", note: outcome.label };
  if (outcome.kind === "draw") return { title: "Empate", note: outcome.label };
  const named = victoryLine(outcome, participants, labels);
  return {
    title: named ?? "Vitória",
    note: outcome.san ? `Mate. ${outcome.san}` : outcome.label,
  };
}

export function ResultScreen({
  session,
  participants,
  labels,
  analysis,
  manualStop,
  onBack,
  onRestart,
  onExport,
  busy,
}: ResultScreenProps) {
  const history = session?.history ?? [];
  const copy = resultCopy(session, manualStop, participants, labels);
  const winnerSlot = session?.outcome?.kind === "checkmate" || session?.outcome?.kind === "timeout" ? session.outcome.winnerSlot : null;
  const jevEntries = history.filter((entry) => isJevEntry(entry, participants));
  const jevParticipants = participants.filter(isJevParticipant).length;
  const kicker = session?.mode === "compare" ? "Comparação" : "Resultado";

  return (
    <section className="result" id="resultado">
      <div className="result-hero">
        <div className="result-copy">
          <p className="eyebrow">{kicker}</p>
          <h2>{copy.title}</h2>
          <p className="lede">{copy.note}</p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onBack}>
            Voltar ao tabuleiro
          </button>
          <button type="button" className="btn btn-secondary" onClick={onRestart} disabled={!session || busy}>
            Nova sessão
          </button>
          <button type="button" className="btn btn-ghost" onClick={onExport} disabled={!session || busy}>
            Exportar
          </button>
        </div>
      </div>

      <div className="totals">
        <article className="block jev-total">
          <h3>Total do JEV</h3>
          <p className="figure mono">
            {jevParticipants === 0
              ? "O JEV não está nesta sessão."
              : session?.totals?.jev
                ? formatCostTotal(session.totals.jev)
                : summarizeCost(
                    jevEntries.map((entry) => ({
                      costUsd: entry.costUsd,
                      costNature: entry.costNature,
                      provider: "jev" as const,
                    })),
                  ).text}
          </p>
          <p className="hint">
            {jevEntries.length === 0
              ? "Sem chamada do JEV."
              : `${formatCount(jevEntries.length)} ${jevEntries.length === 1 ? "chamada" : "chamadas"}.${
                  jevEntries.some((entry) => entry.mode === "demo")
                    ? " Custo simulado, tarifa ilustrativa."
                    : jevEntries.some((entry) => entry.costNature === "estimated")
                      ? " Estimativa não é fatura."
                      : ""
                }`}
          </p>
        </article>
        <article className="block">
          <h3>Soma das durações</h3>
          <p className="figure mono">{summarizeDurations(history.map((entry) => entry.durationMs))}</p>
        </article>
        <article className="block">
          <h3>Relógio da sessão</h3>
          <p className="figure mono">{formatDuration(session?.sessionClockMs)}</p>
        </article>
      </div>

      <div className="result-fighters">
        {([0, 1] as Slot[]).map((slot) => {
          const config = participants.find((item) => item.slot === slot);
          const rows = callsFor(history, slot);
          const provider = config?.provider ?? null;
          const last = rows.at(-1) ?? null;
          const battle = session?.mode === "battle";
          const side = battle ? (slot === 0 ? "side-w" : "side-b") : "side-n";
          return (
            <article key={slot} className={`block fighter ${side}${winnerSlot === slot ? " winner" : ""}`}>
              <header className="fighter-head">
                {battle ? <span className="seat" aria-hidden="true" /> : <span className="seat-num" aria-hidden="true">{slot + 1}</span>}
                <h3>{slotTitle(slot, battle)}</h3>
                {winnerSlot === slot ? <span className="turn win">vencedor</span> : null}
              </header>
              <p className="who">{config ? modelLabel(config.modelId, labels) : "Sem modelo"}</p>
              <p className="origin">
                {providerLabel(provider)}
                {isSimulated(last, config) ? <> <SimTag /></> : null}
              </p>
              <MetricList
                rows={[
                  { label: "Chamadas", value: formatCount(rows.length) },
                  { label: "Último lance", value: displayMove(last, session) },
                  { label: "Tokens de entrada", value: summarizeNumbers(rows.map((entry) => entry.inputTokens)) },
                  { label: "Tokens de saída", value: summarizeNumbers(rows.map((entry) => entry.outputTokens)) },
                  { label: "Tempo acumulado", value: summarizeDurations(rows.map((entry) => entry.durationMs)) },
                  ...(session?.clock ? [{ label: "Relógio restante", value: formatClock(session.clock.remainingMs[slot]) }] : []),
                  {
                    label: "Custo",
                    value: summarizeCost(
                      rows.map((entry) => ({
                        costUsd: entry.costUsd,
                        costNature: entry.costNature,
                        provider: entryProvider(entry, participants),
                      })),
                    ).text,
                  },
                ]}
              />
            </article>
          );
        })}
      </div>

      {session?.mode === "battle" ? <AnalysisPanel state={analysis} labels={labels} participants={participants} /> : null}
    </section>
  );
}
