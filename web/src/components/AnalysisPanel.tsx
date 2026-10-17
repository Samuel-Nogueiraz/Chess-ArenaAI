import { formatCount, formatDuration } from "../format";
import type { GameAnalysis, ParticipantConfig } from "../types";
import { modelLabel } from "../view";
import { SimTag } from "./SimTag";

export type AnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: GameAnalysis };

interface AnalysisPanelProps {
  state: AnalysisState;
  labels: Map<string, string>;
  participants: ParticipantConfig[];
}

function percent(value: number | null): string {
  return value == null ? "Indisponível" : `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function centipawns(value: number | null, unit = false): string {
  if (value == null) return "Indisponível";
  const text = value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  return unit ? `${text} cp` : text;
}

export function AnalysisPanel({ state, labels, participants }: AnalysisPanelProps) {
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <section className="block analysis" aria-label="Análise da partida">
        <h3>Análise da partida</h3>
        <p className="hint" role="status">Analisando os lances.</p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="block analysis" aria-label="Análise da partida">
        <h3>Análise da partida</h3>
        <p className="note fail"><span className="note-label">Falha</span>{state.message}</p>
      </section>
    );
  }
  const { data } = state;
  const simulated = participants.some((item) => item.provider === "demo");
  return (
    <section className="block analysis" aria-label="Análise da partida">
      <h3>
        Análise da partida {simulated ? <SimTag /> : null}
      </h3>
      <p className="hint">
        Motor {data.engine}, profundidade {data.depth}. {data.moves.length === 0 ? "Nenhum lance aplicado para avaliar." : ""}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Participante</th>
              <th>Modelo</th>
              <th>Precisão</th>
              <th>Perda média</th>
              <th>Melhores</th>
              <th>Bons</th>
              <th>Imprecisões</th>
              <th>Erros</th>
              <th>Erros graves</th>
              <th>Inválidos</th>
              <th>Tempo por lance</th>
            </tr>
          </thead>
          <tbody>
            {data.players.map((player) => {
              const config = participants.find((item) => item.slot === player.slot);
              return (
                <tr key={player.slot}>
                  <td>Participante {player.slot + 1}</td>
                  <td>{modelLabel(config?.modelId ?? player.modelId, labels)}</td>
                  <td className="mono">{percent(player.accuracy)}</td>
                  <td className="mono">{centipawns(player.acpl, true)}</td>
                  <td className="mono">{formatCount(player.best)}</td>
                  <td className="mono">{formatCount(player.good)}</td>
                  <td className="mono">{formatCount(player.inaccuracies)}</td>
                  <td className="mono">{formatCount(player.mistakes)}</td>
                  <td className="mono">{formatCount(player.blunders)}</td>
                  <td className="mono">{formatCount(player.invalid)}</td>
                  <td className="mono">{formatDuration(player.avgMoveMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.moves.length > 0 ? (
        <details className="analysis-moves">
          <summary>Lance a lance ({formatCount(data.moves.length)})</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Participante</th>
                  <th>Lance</th>
                  <th>Melhor</th>
                  <th>Perda</th>
                  <th>Classe</th>
                </tr>
              </thead>
              <tbody>
                {data.moves.map((move, index) => (
                  <tr key={`${move.ply}-${index}`}>
                    <td className="mono">{move.ply}</td>
                    <td>{move.slot + 1}</td>
                    <td className="mono">{move.san}</td>
                    <td className="mono">{move.bestSan ?? "Indisponível"}</td>
                    <td className="mono">{centipawns(move.cpLoss, true)}</td>
                    <td className={move.label === "erro" || move.label === "erro grave" ? "bad" : undefined}>{move.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}
