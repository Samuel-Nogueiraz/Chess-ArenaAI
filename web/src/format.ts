import type { CostNature, CostTotal, HistoryEntry, ProviderId } from "./types";

export const UNAVAILABLE = "Indisponível";
export const CURSOR_COST = "Indisponível no Cursor";
export const INCLUDED = "Incluso no plano";

export function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return UNAVAILABLE;
  return value.toLocaleString("pt-BR");
}

export function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return UNAVAILABLE;
  const seconds = value / 1000;
  return `${seconds.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} s`;
}

export function formatClock(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return UNAVAILABLE;
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatConfidence(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return UNAVAILABLE;
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 4 });
}

export function formatDistribution(value: Record<string, number> | null | undefined): string {
  if (!value) return UNAVAILABLE;
  const parts = Object.entries(value).map(([id, weight]) => `${id} ${formatConfidence(weight)}`);
  return parts.length ? parts.join(", ") : UNAVAILABLE;
}

export function formatCostTotal(total: CostTotal | null | undefined): string {
  if (!total) return UNAVAILABLE;
  if (total.availability === "included") return INCLUDED;
  if (total.availability === "unavailable" || typeof total.costUsd !== "number") return "Total indisponível";
  const value = formatUsd(total.costUsd);
  if (total.availability === "partial") {
    const missing =
      typeof total.unavailableCount === "number"
        ? ` ${plural(total.unavailableCount, "indisponível", "indisponíveis")}.`
        : "";
    return `${value}. Total conhecido parcial.${missing}`;
  }
  if (typeof total.includedCount === "number" && total.includedCount > 0) {
    return `${value}. ${plural(total.includedCount, "inclusa no plano", "inclusas no plano")}.`;
  }
  return value;
}

export function formatUsd(value: number): string {
  // Centavos escondem o custo de poucos tokens: abaixo de US$ 0,01 mostra mais casas.
  const small = value > 0 && value < 0.01;
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "USD",
    ...(small ? { maximumFractionDigits: 6 } : {}),
  });
}

export function formatCost(
  costUsd: number | null | undefined,
  nature: CostNature | null | undefined,
  provider?: ProviderId | null,
): string {
  if (nature === "included") return INCLUDED;
  if (typeof costUsd === "number" && nature !== "unavailable") {
    const value = formatUsd(costUsd);
    if (nature === "estimated") return `${value} estimativa`;
    if (nature === "reported") return `${value} reportado`;
    return value;
  }
  return provider === "cursor" ? CURSOR_COST : UNAVAILABLE;
}

export interface ParcelSummary {
  text: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function summarizeCost(
  items: { costUsd: number | null; costNature: CostNature | null; provider: ProviderId | null }[],
): ParcelSummary {
  if (items.length === 0) return { text: "Sem chamada." };
  let sum = 0;
  let known = 0;
  let unavailable = 0;
  let included = 0;
  for (const item of items) {
    if (item.costNature === "included") {
      included += 1;
      continue;
    }
    if (
      (item.costNature === "reported" || item.costNature === "estimated") &&
      typeof item.costUsd === "number"
    ) {
      sum += item.costUsd;
      known += 1;
      continue;
    }
    unavailable += 1;
  }
  if (known === 0) return { text: "Total indisponível" };
  const notes: string[] = [];
  if (unavailable > 0) notes.push(plural(unavailable, "indisponível", "indisponíveis"));
  if (included > 0) notes.push(plural(included, "inclusa no plano", "inclusas no plano"));
  if (notes.length === 0) return { text: formatUsd(sum) };
  return { text: `${formatUsd(sum)}. Total conhecido parcial. ${notes.join(". ")}.` };
}

export function summarizeNumbers(values: (number | null)[], empty = "Sem chamada."): string {
  if (values.length === 0) return empty;
  const present = values.filter((value): value is number => typeof value === "number");
  const missing = values.length - present.length;
  if (present.length === 0) return UNAVAILABLE;
  const sum = present.reduce((total, value) => total + value, 0);
  if (missing > 0) {
    return `${formatCount(sum)}. Parcial. ${plural(missing, "indisponível", "indisponíveis")}.`;
  }
  return formatCount(sum);
}

export function summarizeDurations(values: (number | null)[]): string {
  if (values.length === 0) return "Sem chamada.";
  const present = values.filter((value): value is number => typeof value === "number");
  const missing = values.length - present.length;
  if (present.length === 0) return UNAVAILABLE;
  const sum = present.reduce((total, value) => total + value, 0);
  if (missing > 0) {
    return `${formatDuration(sum)}. Parcial. ${plural(missing, "indisponível", "indisponíveis")}.`;
  }
  return formatDuration(sum);
}

export function providerLabel(provider: ProviderId | null | undefined): string {
  if (provider === "demo") return "Demo";
  if (provider === "jev") return "JEV";
  if (provider === "cursor") return "Cursor";
  if (provider === "cli") return "CLI";
  if (provider === "openai") return "API compatível com OpenAI";
  return UNAVAILABLE;
}

export function validationLabel(validation: HistoryEntry["validation"]): string {
  if (validation === "aceita") return "Aceita";
  if (validation === "recusada") return "Recusada";
  if (validation === "falha") return "Falha";
  return UNAVAILABLE;
}

export function moveLabel(entry: Pick<HistoryEntry, "san" | "choiceId"> | null, fallbackSan?: string | null): string {
  if (!entry) return "Sem chamada.";
  return entry.san ?? fallbackSan ?? entry.choiceId ?? UNAVAILABLE;
}
