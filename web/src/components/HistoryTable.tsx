import type { HistoryEntry, ParticipantConfig, SessionSnapshot } from "../types";
import { formatCost, formatCount, formatDuration, providerLabel, validationLabel } from "../format";
import { displayMove, entryProvider, isSimulated } from "../view";
import { SimTag } from "./SimTag";

interface HistoryTableProps {
  entries: HistoryEntry[];
  session: SessionSnapshot | null;
  participants: ParticipantConfig[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

export function HistoryTable({ entries, session, participants, selectedIndex, onSelect }: HistoryTableProps) {
  return (
    <section className="history">
      <h3>Histórico</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Modelo</th>
              <th>Origem</th>
              <th>Lance</th>
              <th>Duração</th>
              <th>Entrada</th>
              <th>Saída</th>
              <th>Custo</th>
              <th>Validação</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty">
                  Sem chamadas nesta sessão.
                </td>
              </tr>
            ) : (
              entries.map((entry, index) => {
                const provider = entryProvider(entry, participants);
                const bad = entry.validation === "falha" || entry.validation === "recusada";
                return (
                  <tr
                    key={`${entry.slot}-${index}-${entry.choiceId ?? "none"}`}
                    className={selectedIndex === index ? "selected" : undefined}
                    onClick={() => onSelect(index)}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(index);
                      }
                    }}
                  >
                    <td className="mono">{index + 1}</td>
                    <td>
                      {entry.modelRequested}
                      {isSimulated(entry) ? <> <SimTag /></> : null}
                    </td>
                    <td>{providerLabel(provider)}</td>
                    <td className="mono">{displayMove(entry, session)}</td>
                    <td className="mono">{formatDuration(entry.durationMs)}</td>
                    <td className="mono">{formatCount(entry.inputTokens)}</td>
                    <td className="mono">{formatCount(entry.outputTokens)}</td>
                    <td className="mono">{formatCost(entry.costUsd, entry.costNature, provider)}</td>
                    <td className={bad ? "bad" : undefined}>{validationLabel(entry.validation)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
