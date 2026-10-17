import type { HistoryEntry, ParticipantConfig, SessionSnapshot, Slot } from "../types";
import { formatCost, formatCount, formatDuration, validationLabel } from "../format";
import { displayMove, entryProvider, isSimulated, slotTitle } from "../view";
import { SimTag } from "./SimTag";

interface CompareTableProps {
  session: SessionSnapshot;
  participants: ParticipantConfig[];
  rows: { slot: Slot; entry: HistoryEntry | null; modelName: string }[];
  onSelect: (slot: Slot) => void;
}

export function CompareTable({ session, participants, rows, onSelect }: CompareTableProps) {
  return (
    <section className="compare" aria-label="Tabela comparativa">
      <h3>Comparação</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Participante</th>
              <th>Modelo</th>
              <th>Lance</th>
              <th>Duração</th>
              <th>Entrada</th>
              <th>Saída</th>
              <th>Custo</th>
              <th>Validação</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ slot, entry, modelName }) => {
              const config = participants.find((item) => item.slot === slot);
              const provider = entry ? entryProvider(entry, participants) : config?.provider ?? null;
              const bad = entry?.validation === "falha" || entry?.validation === "recusada";
              return (
                <tr
                  key={slot}
                  onClick={() => onSelect(slot)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(slot);
                    }
                  }}
                >
                  <td>{slotTitle(slot, false)}</td>
                  <td>
                    {entry?.modelRequested ?? modelName}
                    {isSimulated(entry, config) ? <> <SimTag /></> : null}
                  </td>
                  <td className="mono">{displayMove(entry, session)}</td>
                  <td className="mono">{formatDuration(entry?.durationMs)}</td>
                  <td className="mono">{formatCount(entry?.inputTokens)}</td>
                  <td className="mono">{formatCount(entry?.outputTokens)}</td>
                  <td className="mono">{entry ? formatCost(entry.costUsd, entry.costNature, provider) : "Sem chamada."}</td>
                  <td className={bad ? "bad" : undefined}>{entry ? validationLabel(entry.validation) : "Sem chamada."}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">Mesma posição. Nenhum lance é aplicado.</p>
    </section>
  );
}
