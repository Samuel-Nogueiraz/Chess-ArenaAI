import {
  SessionError,
  type AdapterDecision,
  type AdapterRequest,
  type DecisionAdapter,
  type Participant,
  type ProviderId,
} from "@arena/core";
import { failedDecision } from "./util.js";

export type ProviderKind = "demo" | "api" | "sdk" | "cli";

export interface ProviderStatus {
  available: boolean;
  reason: string | null;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderModule {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** Quando true, só aceita os ids que `models()` devolve (demo, cli, openai). */
  strictModels?: boolean;
  status(): Promise<ProviderStatus>;
  models(): Promise<ModelOption[]>;
  decide(request: AdapterRequest): Promise<AdapterDecision>;
  openSession?(session: { sessionId: string; participants: Participant[] }): void;
  closeAll?(): void;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  available: boolean;
  reason: string | null;
  models: ModelOption[];
}

export interface Registry extends DecisionAdapter {
  list(): Promise<ProviderInfo[]>;
  /** Recusa (400) provedor ausente, indisponível ou modelo desconhecido. */
  assertUsable(participants: Participant[]): Promise<void>;
  openSession(session: { sessionId: string; participants: Participant[] }): void;
  closeAll(): void;
}

const MODELS_TIMEOUT_MS = 5_000;

export function createRegistry(modules: ProviderModule[]): Registry {
  const byId = new Map<ProviderId, ProviderModule>();
  for (const module of modules) {
    if (byId.has(module.id)) throw new Error(`Provedor duplicado: ${module.id}`);
    byId.set(module.id, module);
  }

  async function statusOf(module: ProviderModule): Promise<ProviderStatus> {
    try {
      return await module.status();
    } catch {
      return { available: false, reason: "falha ao verificar o provedor" };
    }
  }

  async function modelsOf(module: ProviderModule): Promise<ModelOption[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<ModelOption[]>((resolve) => {
      timer = setTimeout(() => resolve([]), MODELS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([module.models().catch(() => [] as ModelOption[]), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async list() {
      return Promise.all(
        modules.map(async (module) => {
          const status = await statusOf(module);
          return {
            id: module.id,
            label: module.label,
            kind: module.kind,
            available: status.available,
            reason: status.available ? null : (status.reason ?? "indisponível"),
            models: await modelsOf(module),
          };
        }),
      );
    },

    async assertUsable(participants) {
      for (const participant of participants) {
        const module = byId.get(participant.provider);
        if (!module) throw new SessionError(`Provedor "${participant.provider}" não está registrado.`);
        const status = await statusOf(module);
        if (!status.available) {
          throw new SessionError(`Provedor "${participant.provider}" indisponível: ${status.reason ?? "motivo desconhecido"}.`);
        }
        if (module.strictModels) {
          const models = await modelsOf(module);
          if (!models.some((model) => model.id === participant.modelId)) {
            throw new SessionError(`Modelo "${participant.modelId}" desconhecido no provedor "${participant.provider}".`);
          }
        }
      }
    },

    async decide(request) {
      const module = byId.get(request.participant.provider);
      const prompt = request.context.objective;
      if (!module) return failedDecision(prompt, "provedor não registrado");
      const status = await statusOf(module);
      if (!status.available) return failedDecision(prompt, `provedor indisponível. ${status.reason ?? ""}`.trim());
      try {
        return await module.decide(request);
      } catch {
        return failedDecision(prompt, "falha interna do provedor");
      }
    },

    openSession(session) {
      for (const module of modules) module.openSession?.(session);
    },

    closeAll() {
      for (const module of modules) module.closeAll?.();
    },
  };
}
