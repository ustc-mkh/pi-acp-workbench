import type { PiModel } from './pi-rpc-types';
import { validPrice } from './telemetry';
import { modelDefaultKey } from './workbench-model-defaults';
const providers = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'xai',
  'deepseek',
  'openai-codex',
  'groq',
];
const priority = (provider?: string) => {
  const index = providers.indexOf(provider ?? '');
  return index < 0 ? 100 : index;
};
export function piModelDefaults(models: PiModel[], catalogue: PiModel[] = models) {
  return models
    .filter((m) => m.provider && m.id)
    .map((model) => {
      const key = modelDefaultKey(model.id!);
      const candidates = catalogue
        .filter((m) => m.id && modelDefaultKey(m.id) === key)
        .sort(
          (a, b) =>
            priority(a.provider) - priority(b.provider) ||
            `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
        );
      const priced =
        candidates.find((m) => priority(m.provider) < 100 && validPrice(m.cost)) ??
        candidates.find(
          (m) =>
            validPrice(m.cost) &&
            Object.values(m.cost!).some((n) => typeof n === 'number' && n > 0),
        ) ??
        candidates.find((m) => validPrice(m.cost));
      const context = candidates.find(
        (m) =>
          Number.isSafeInteger(m.contextWindow) &&
          m.contextWindow! > 0 &&
          m.contextWindow! <= 100000000,
      );
      return {
        model: `${model.provider}/${model.id}`,
        price: priced
          ? {
              input: priced.cost!.input,
              output: priced.cost!.output,
              cache_read: priced.cost!.cacheRead,
              cache_write: priced.cost!.cacheWrite,
            }
          : null,
        contextWindow: context?.contextWindow ?? null,
      };
    });
}
