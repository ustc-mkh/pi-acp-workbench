import type { PiModel } from './pi-rpc-types';
import { validPrice } from './telemetry';
import { modelDefaultKey } from './workbench-model-defaults';

function metadata(models: PiModel[]) {
  return models
    .filter((m) => m.provider && m.id)
    .map((m) => ({
      model: `${m.provider}/${m.id}`,
      price: validPrice(m.cost)
        ? {
            input: m.cost.input,
            output: m.cost.output,
            cache_read: m.cost.cacheRead,
            cache_write: m.cost.cacheWrite,
          }
        : null,
      contextWindow:
        Number.isSafeInteger(m.contextWindow) &&
        m.contextWindow! > 0 &&
        m.contextWindow! <= 100000000
          ? m.contextWindow!
          : null,
    }));
}

/** The SDK can see unconfigured providers. Send only numeric metadata for relevant aliases.
 * Ordering, default selection and user overrides belong to the host. */
export function piModelMetadata(available: PiModel[], registry?: PiModel[]) {
  const models = metadata(available);
  const keys = new Set(models.map((m) => modelDefaultKey(m.model)));
  return {
    models,
    candidates:
      registry && metadata(registry.filter((m) => m.id && keys.has(modelDefaultKey(m.id)))),
  };
}
export type PiModelMetadata = ReturnType<typeof piModelMetadata>;
