import type { HistoryEntry, SessionSnapshot } from "../types";
import { formatConfidence, formatCost, formatCount, formatDistribution, formatDuration, providerLabel, validationLabel } from "../format";
import { displayMove, entryProvider } from "../view";
import type { ParticipantConfig } from "../types";
import { MetricList } from "./MetricList";

interface CallDetailProps {
  entry: HistoryEntry | null;
  session: SessionSnapshot | null;
  participants: ParticipantConfig[];
  busyLabel: string | null;
}

export function CallDetail({ entry, session, participants, busyLabel }: CallDetailProps) {
  const provider = entry ? entryProvider(entry, participants) : null;
  const rows = entry
    ? [
        { label: "Origem", value: providerLabel(provider) },
        { label: "Modelo pedido", value: entry.modelRequested },
        { label: "Modelo devolvido", value: entry.modelReturned ?? "Indisponível" },
        { label: "Lance", value: displayMove(entry, session) },
        { label: "Id", value: entry.choiceId ?? "Indisponível" },
        { label: "Validação", value: validationLabel(entry.validation) },
        { label: "Duração de relógio", value: formatDuration(entry.durationMs) },
        { label: "Duração do SDK", value: formatDuration(entry.sdkDurationMs) },
        { label: "Tokens de entrada", value: formatCount(entry.inputTokens) },
        { label: "Tokens de saída", value: formatCount(entry.outputTokens) },
        { label: "Custo", value: formatCost(entry.costUsd, entry.costNature, provider) },
        { label: "Distribuição", value: formatConfidence(entry.confidence) },
        { label: "Distribuição por lance", value: formatDistribution(entry.distribution) },
        { label: "Modo", value: entry.mode ?? "Indisponível" },
        { label: "Aplicado", value: entry.applied == null ? "Indisponível" : entry.applied ? "Sim" : "Não" },
        { label: "Registro lógico", value: entry.logical == null ? "Indisponível" : entry.logical ? "Sim" : "Não" },
        { label: "FEN da chamada", value: entry.fen ?? "Indisponível" },
        {
          label: "Ids oferecidos",
          value: entry.candidateIds?.length ? entry.candidateIds.join(" ") : "Indisponível",
        },
      ]
    : [];

  return (
    <section className="block detail">
      <h3>Detalhe da chamada</h3>
      {busyLabel ? <p>{busyLabel}</p> : null}
      {!entry && !busyLabel ? <p className="empty">Sem chamada nesta sessão.</p> : null}
      {entry ? <MetricList rows={rows} /> : null}
      {entry?.failureReason ? <p className="fail-text">{entry.failureReason}</p> : null}
    </section>
  );
}
