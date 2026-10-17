import type { ModelOption, ParticipantConfig, ProviderInfo, Slot } from "./types";

export interface Matchup {
  label: string;
  participants: ParticipantConfig[];
}

const DEMO_SUFFIX = / · simulado$/;
const DEMO_JEV = "jev-demo";
const DEMO_RIVAL = "rival-greedy";
const MAX_MATCHUPS = 4;

export function optionValue(option: Pick<ModelOption, "provider" | "id">): string {
  return `${option.provider}:${option.id}`;
}

/** Todos os modelos de todos os provedores, na ordem em que o servidor listou. */
export function allOptions(providers: ProviderInfo[]): ModelOption[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({ id: model.id, label: model.label, provider: provider.id })),
  );
}

/** Só os modelos que dá para usar agora. */
export function availableOptions(providers: ProviderInfo[]): ModelOption[] {
  return allOptions(providers.filter((provider) => provider.available));
}

function configOf(slot: Slot, option: ModelOption | undefined): ParticipantConfig {
  return { slot, provider: option?.provider ?? "demo", modelId: option?.id ?? "" };
}

/** Padrão: JEV real se estiver disponível, senão o JEV simulado; contra o rival guloso. */
export function defaultParticipants(providers: ProviderInfo[]): [ParticipantConfig, ParticipantConfig] {
  const options = availableOptions(providers);
  const first =
    options.find((option) => option.provider === "jev") ??
    options.find((option) => option.provider === "demo" && option.id === DEMO_JEV) ??
    options[0];
  const second =
    options.find((option) => option !== first && option.provider === "demo" && option.id === DEMO_RIVAL) ??
    options.find((option) => option !== first);
  return [configOf(0, first), configOf(1, second)];
}

/** Mantém a escolha que ainda vale; troca pelo padrão a que sumiu ou ficou indisponível. */
export function reconcileParticipants(current: ParticipantConfig[], providers: ProviderInfo[]): ParticipantConfig[] {
  const usable = availableOptions(providers);
  const defaults = defaultParticipants(providers);
  return current.map((participant) => {
    const stillThere =
      participant.modelId !== "" &&
      usable.some((option) => option.provider === participant.provider && option.id === participant.modelId);
    return stillThere ? participant : (defaults[participant.slot] ?? participant);
  });
}

/**
 * Confrontos rápidos: o primeiro modelo (JEV real, se houver) contra um modelo de cada outro provedor
 * disponível, e contra cada modelo demo.
 */
export function quickMatchups(providers: ProviderInfo[]): Matchup[] {
  const usable = providers.filter((provider) => provider.available && provider.models.length > 0);
  const options = availableOptions(providers);
  if (options.length < 2) return [];
  const anchor =
    options.find((option) => option.provider === "jev") ??
    options.find((option) => option.provider !== "demo") ??
    options[0];
  if (!anchor) return [];
  const others: ModelOption[] = [];
  for (const provider of usable.filter((item) => item.id !== "demo")) {
    const head = allOptions([provider])[0];
    if (head && head !== anchor && !(head.provider === anchor.provider && head.id === anchor.id)) others.push(head);
  }
  for (const provider of usable.filter((item) => item.id === "demo")) {
    for (const option of allOptions([provider])) {
      if (!(option.provider === anchor.provider && option.id === anchor.id)) others.push(option);
    }
  }
  return others.slice(0, MAX_MATCHUPS).map((other) => {
    const bothDemo = anchor.provider === "demo" && other.provider === "demo";
    const right = bothDemo ? other.label.replace(DEMO_SUFFIX, "") : other.label;
    return {
      label: `${anchor.label} × ${right}`,
      participants: [configOf(0, anchor), configOf(1, other)],
    };
  });
}
