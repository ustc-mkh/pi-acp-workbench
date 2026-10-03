import type { Price } from './telemetry';
// USD per million tokens; standard short-context API rates, checked 2026-10-03.
// Pi's own selected-model cost table supplies other models. All rates are editable.
const openai = 'https://developers.openai.com/api/docs/pricing';
const anthropic = 'https://platform.claude.com/docs/en/about-claude/pricing';
const price = (input:number, output:number, cacheRead:number, cacheWrite:number, source:string): Price => ({input,output,cacheRead,cacheWrite,source,updated:'2026-10-03'});
export const presetPrices: Record<string, Price> = {
  'gpt-6-astra': price(10,50,1,12.5,openai),
  'gpt-6.1-sol': price(2,10,.1,2.5,openai),
  'gpt-6-luna': price(.1,.5,.01,.125,openai),
  'gpt-5.3-codex': price(1.75,14,.175,1.75,openai),
  'claude-sonnet-4-6': price(3,15,.3,3.75,anthropic),
  'claude-sonnet-4-5': price(3,15,.3,3.75,anthropic),
  'claude-opus-4-6': price(5,25,.5,6.25,anthropic),
  'claude-haiku-4-5': price(1,5,.1,1.25,anthropic),
  'claude-sonnet-5-5': price(2,10,.2,2.5,anthropic),
  'claude-opus-5-5': price(4,20,.2,5,anthropic),
};
