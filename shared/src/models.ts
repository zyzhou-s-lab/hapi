import { splitAgyModelSelection } from './agyModels'

export const CLAUDE_MODEL_LABELS = {
    fable: 'Fable',
    'fable[1m]': 'Fable 1M',
    sonnet: 'Sonnet',
    'sonnet[1m]': 'Sonnet 1M',
    opus: 'Opus',
    'opus[1m]': 'Opus 1M',
    haiku: 'Haiku'
} as const

export type ClaudeModelPreset = keyof typeof CLAUDE_MODEL_LABELS
export const CLAUDE_MODEL_PRESETS = Object.keys(CLAUDE_MODEL_LABELS) as ClaudeModelPreset[]

export const CLAUDE_MODEL_ID_LABELS = {
    'claude-fable-5': 'Fable 5',
    'claude-opus-4-8': 'Opus 4.8',
    'claude-opus-4-7': 'Opus 4.7',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-opus-4-5': 'Opus 4.5',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-haiku-4-5': 'Haiku 4.5'
} as const

export type ClaudeModelId = keyof typeof CLAUDE_MODEL_ID_LABELS
export const CLAUDE_MODEL_IDS = Object.keys(CLAUDE_MODEL_ID_LABELS) as ClaudeModelId[]

export const GEMINI_MODEL_LABELS = {
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
    'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
} as const

export type GeminiModelPreset = keyof typeof GEMINI_MODEL_LABELS
export const GEMINI_MODEL_PRESETS = Object.keys(GEMINI_MODEL_LABELS) as GeminiModelPreset[]
export const DEFAULT_GEMINI_MODEL: GeminiModelPreset = 'gemini-2.5-pro'

// Order and labels mirror `agy models` output (the agy CLI's own listing) so the
// HAPI picker matches what users see in the terminal. IDs follow agy's
// `<model>-<effort>` convention (e.g. `gemini-3.5-flash-low` verified accepted by
// `agy --model`). NOTE: agy fetches the live list server-side and `agy models`
// needs an interactive keyring unlock, so this stays a hand-maintained mirror —
// update it when agy's listing changes.
export const AGY_MODEL_LABELS = {
    'gemini-4-carbon-medium': 'Gemini 4 Carbon (Medium)',
    'gemini-4-carbon-high': 'Gemini 4 Carbon (High)',
    'gemini-4-carbon-low': 'Gemini 4 Carbon (Low)',
    'gemini-4-argon-medium': 'Gemini 4 Argon (Medium)',
    'gemini-4-argon-high': 'Gemini 4 Argon (High)',
    'gemini-4-argon-low': 'Gemini 4 Argon (Low)',
    'gemini-4-hydrogen-high': 'Gemini 4 Hydrogen (High)',
    'gemini-4-hydrogen-xhigh': 'Gemini 4 Hydrogen (XHigh)',
    'gemini-4-hydrogen-medium': 'Gemini 4 Hydrogen (Medium)',
    'gemini-4-hydrogen-low': 'Gemini 4 Hydrogen (Low)',
    'gemini-pro-orchestrator': 'Orchestrator (Carbon)',
    'gemini-pro-orchestrator-argon': 'Orchestrator (Argon)',
    'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
    'claude-opus-5-5-low': 'Claude Opus 5.5 (Low)',
    'claude-opus-5-5-medium': 'Claude Opus 5.5 (Medium)',
    'claude-opus-5-5-high': 'Claude Opus 5.5 (High)',
    'claude-sonnet-5-5-low': 'Claude Sonnet 5.5 (Low)',
    'claude-sonnet-5-5-medium': 'Claude Sonnet 5.5 (Medium)',
    'claude-sonnet-5-5-high': 'Claude Sonnet 5.5 (High)',
    'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
} as const

export const LEGACY_AGY_MODEL_LABELS = {
    'gemini-3.7-flash-high': 'Gemini 3.7 Flash (High)',
    'gemini-3.7-flash-medium': 'Gemini 3.7 Flash (Medium)',
    'gemini-3.7-flash-low': 'Gemini 3.7 Flash (Low)',
    'gemini-3.6-flash-high': 'Gemini 3.6 Flash (High)',
    'gemini-3.6-flash-medium': 'Gemini 3.6 Flash (Medium)',
    'gemini-3.6-flash-low': 'Gemini 3.6 Flash (Low)',
    'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
    'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
    'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
    'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)',
    'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
} as const

export type AgyModelPreset = keyof typeof AGY_MODEL_LABELS
export const AGY_MODEL_PRESETS = Object.keys(AGY_MODEL_LABELS) as AgyModelPreset[]

const AGY_FAMILY_LABELS: ReadonlyMap<string, string> = (() => {
    const labels = new Map<string, string>()
    for (const [id, label] of Object.entries({ ...LEGACY_AGY_MODEL_LABELS, ...AGY_MODEL_LABELS })) {
        const { model, effort } = splitAgyModelSelection(id)
        if (!model || !effort || labels.has(model)) continue
        labels.set(model, label.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)\s*$/i, ''))
    }
    return labels
})()

export function getAgyModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) return null
    return AGY_MODEL_LABELS[trimmedModel as AgyModelPreset]
        ?? LEGACY_AGY_MODEL_LABELS[trimmedModel as keyof typeof LEGACY_AGY_MODEL_LABELS]
        ?? AGY_FAMILY_LABELS.get(trimmedModel)
        ?? null
}

export function isClaudeModelPreset(model: string | null | undefined): model is ClaudeModelPreset {
    return typeof model === 'string' && Object.hasOwn(CLAUDE_MODEL_LABELS, model)
}

export function getClaudeModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return CLAUDE_MODEL_LABELS[trimmedModel as ClaudeModelPreset]
        ?? CLAUDE_MODEL_ID_LABELS[trimmedModel as ClaudeModelId]
        ?? null
}
