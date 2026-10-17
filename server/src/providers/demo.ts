import { createDemoAdapter, DEMO_MODELS, DEMO_PROVIDER_LABEL, type DemoOptions } from "@arena/core";
import type { ProviderModule } from "./registry.js";

/** Provedor demo: sempre disponível, sem rede e sem chave. */
export function createDemoProvider(options: DemoOptions = {}): ProviderModule {
  const adapter = createDemoAdapter(options);
  return {
    id: "demo",
    label: DEMO_PROVIDER_LABEL,
    kind: "demo",
    strictModels: true,
    async status() {
      return { available: true, reason: null };
    },
    async models() {
      return DEMO_MODELS.map((model) => ({ id: model.id, label: model.label }));
    },
    decide(request) {
      return adapter.decide(request);
    },
  };
}
