/** Default DeepSeek model catalog. */
import type { LlmModelCost } from '@deepseek-ai/dsh-llm'
import { DEFAULT_CONTEXT_WINDOW } from './defaults.ts'
import type { DeepSeekCatalogModel } from './types.ts'

/**
 * Published DeepSeek prices in USD per million billed tokens, taken from the
 * provider's own rate card as the installed pi-ai catalog records it
 * (`@earendil-works/pi-ai`, `dist/providers/data/deepseek.json`):
 * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` declare
 * `0.14` in / `0.28` out / `0.0028` cache-read / `0` cache-write, and
 * `deepseek-v4-pro` declares `0.435` in / `0.87` out / `0.003625` cache-read
 * / `0` cache-write. This catalog's `deepseek-flash` is the deployment-facing
 * name for the published flash route, so it carries the flash rates. These
 * are catalog estimates for cost reporting, never invoices: a deployment with
 * different terms replaces them through its own `models[].cost`.
 */
const FLASH_COST: LlmModelCost = {
  inputPerMTok: 0.14,
  outputPerMTok: 0.28,
  cacheReadPerMTok: 0.0028,
  cacheWritePerMTok: 0,
}

/** Published `deepseek-v4-pro` prices; see {@link FLASH_COST} for the source. */
const PRO_COST: LlmModelCost = {
  inputPerMTok: 0.435,
  outputPerMTok: 0.87,
  cacheReadPerMTok: 0.003625,
  cacheWritePerMTok: 0,
}

/** Advisory official model entries; deployments may replace the catalog. */
export const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V41-Flash',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    systemPromptUpdate: 'in-history',
    cost: FLASH_COST,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    cost: PRO_COST,
  },
]
