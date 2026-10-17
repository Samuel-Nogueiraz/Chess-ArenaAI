import {
  buildCorrection,
  looseMoveToken,
  parseMoveId,
  type AdapterDecision,
  type CostNature,
  type DecisionContext,
  type ProviderAttempt,
} from "@arena/core";
import { failedDecision } from "./util.js";

/** Uma resposta crua de um provedor de texto livre (CLI, API compatível com OpenAI). */
export interface TextAttempt {
  /** Texto da resposta, ou null se a chamada falhou. */
  text: string | null;
  failureReason: string | null;
  durationMs: number | null;
  sdkDurationMs?: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costNature: CostNature;
  modelReturned: string | null;
  rawResponse: unknown;
}

export interface AskLoopInput {
  context: DecisionContext;
  /** Primeiro pedido. */
  prompt: string;
  /** Faz uma chamada. `isCorrection` vem true na segunda; `answer` é a resposta anterior. */
  ask(prompt: string, step: { isCorrection: boolean; previousAnswer: string }): Promise<TextAttempt>;
  budgetMs?: number | null;
  /** Texto do pedido de correção. Padrão: `buildCorrection`. */
  correction?: (context: DecisionContext, answer: string) => string;
}

/**
 * Pergunta, valida o id contra a lista e corrige uma vez se vier fora dela.
 * Falha de chamada não corrige: o motivo vai direto para a sessão.
 */
export async function askWithCorrection(input: AskLoopInput): Promise<AdapterDecision> {
  const { context } = input;
  const deadline = input.budgetMs != null ? performance.now() + input.budgetMs : null;
  const preludes: ProviderAttempt[] = [];

  let prompt = input.prompt;
  let attempt = await input.ask(prompt, { isCorrection: false, previousAnswer: "" });
  if (attempt.failureReason || attempt.text == null) {
    return carry(failedDecision(prompt, attempt.failureReason ?? "resposta inválida"), attempt);
  }
  let choice = parseMoveId(attempt.text, context.candidates);
  if (choice == null && (deadline == null || performance.now() < deadline)) {
    preludes.push(preludeOf(attempt));
    const answer = attempt.text;
    prompt = (input.correction ?? buildCorrection)(context, answer);
    attempt = await input.ask(prompt, { isCorrection: true, previousAnswer: answer });
    if (attempt.failureReason || attempt.text == null) {
      return { ...carry(failedDecision(prompt, attempt.failureReason ?? "resposta inválida"), attempt), preludes };
    }
    choice = parseMoveId(attempt.text, context.candidates);
  }
  // Ainda fora da lista: devolve o que o modelo disse e deixa a sessão marcar "recusada".
  const reported = choice ?? looseMoveToken(attempt.text);
  return {
    choiceId: reported,
    modelReturned: attempt.modelReturned,
    rawResponse: attempt.rawResponse,
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    costUsd: attempt.costUsd,
    costNature: attempt.costNature,
    sdkDurationMs: attempt.sdkDurationMs ?? null,
    durationMs: attempt.durationMs,
    failureReason: reported ? null : "resposta inválida",
    confidence: null,
    distribution: null,
    prompt,
    preludes,
  };
}

function carry(decision: AdapterDecision, attempt: TextAttempt): AdapterDecision {
  return {
    ...decision,
    modelReturned: attempt.modelReturned,
    rawResponse: attempt.rawResponse,
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    costUsd: attempt.costUsd,
    costNature: attempt.costNature,
    durationMs: attempt.durationMs,
  };
}

function preludeOf(attempt: TextAttempt): ProviderAttempt {
  const loose = attempt.text ? looseMoveToken(attempt.text) : null;
  return {
    logical: false,
    choiceId: loose,
    durationMs: attempt.durationMs,
    failureReason: loose ? "id fora da lista" : "resposta inválida",
    modelReturned: attempt.modelReturned,
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    costUsd: attempt.costUsd,
    costNature: attempt.costNature,
    rawResponse: attempt.rawResponse,
  };
}
