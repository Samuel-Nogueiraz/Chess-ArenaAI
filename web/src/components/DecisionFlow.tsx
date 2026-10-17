import type { Candidate, HistoryEntry } from "../types";
import { validationLabel } from "../format";

interface DecisionFlowProps {
  objective: string;
  sideLabel: string;
  candidates: Candidate[];
  choice: string;
  validation: HistoryEntry["validation"] | "wait" | "idle";
  waiting: boolean;
}

export function DecisionFlow({
  objective,
  sideLabel,
  candidates,
  choice,
  validation,
  waiting,
}: DecisionFlowProps) {
  const validationText =
    waiting || validation === "wait" ? "Consultando." : validation === "idle" ? "Aguardando." : validationLabel(validation);
  const accepted = validation === "aceita" && !waiting;

  return (
    <section className="block flow" aria-label="Fluxo da decisão">
      <h3>Fluxo da decisão</h3>
      <ol>
        <li className="step">
          <span>1</span>
          <div>
            <strong>Posição</strong>
            <p>{sideLabel}</p>
            <p>{objective || "Aguardando o servidor."}</p>
          </div>
        </li>
        <li className="step">
          <span>2</span>
          <div>
            <strong>Candidatos</strong>
            {candidates.length === 0 ? (
              <p>Nenhum lance legal.</p>
            ) : (
              <ul className="candidates">
                {candidates.map((candidate) => (
                  <li key={candidate.id}>
                    {candidate.san === candidate.id ? candidate.id : `${candidate.san} ${candidate.id}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
        <li className="step">
          <span>3</span>
          <div>
            <strong>Escolha</strong>
            <p className="mono">{waiting ? "Consultando." : choice}</p>
          </div>
        </li>
        <li className={`step${accepted ? " ok" : ""}${validation === "recusada" || validation === "falha" ? " bad" : ""}`}>
          <span>4</span>
          <div>
            <strong>Validação</strong>
            <p>{validationText}</p>
          </div>
        </li>
      </ol>
    </section>
  );
}
