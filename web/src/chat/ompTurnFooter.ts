/**
 * Turn footer carried on the terminal assistant message of an omp turn.
 * Field presence is the signal: missing timing is omitted, never invented.
 * Shaping matches omp `packages/tui/src/overlays/usage-row.ts` (`H`, `T`,
 * `lit`, `dt.describe`, `ut`) plus `packages/utils/src/format.ts`.
 */
export type OmpTurnFooter = {
    /** Model-request start, epoch ms. Clock only. */
    requestStartedAtMs?: number
    /** `completedAt - turnStart`, already rounded, milliseconds. */
    elapsedMs?: number
    /** Last model call `input + cacheWrite`. Present only when that call has usage. */
    inputTokens?: number
    outputTokens?: number
    /** Last model call cache read. Omitted when zero. */
    cacheReadTokens?: number
    ttftMs?: number
    /** Generation duration used for tok/s, not the turn elapsed time. */
    durationMs?: number
    /** Sum of `input + cacheWrite + output` across the turn. */
    turnTokens?: number
    turnCostUsd?: number
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseOmpTurnFooter(value: unknown): OmpTurnFooter | undefined {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as Record<string, unknown>
    const inputTokens = finiteNumber(raw.inputTokens)
    const outputTokens = finiteNumber(raw.outputTokens)
    const hasDetail = inputTokens !== undefined && outputTokens !== undefined
    const turnTokens = finiteNumber(raw.turnTokens)
    const turnCostUsd = finiteNumber(raw.turnCostUsd)
    const hasTurn = (turnTokens !== undefined && turnTokens > 0)
        || (turnCostUsd !== undefined && turnCostUsd > 0)
    if (!hasDetail && !hasTurn) return undefined

    const footer: OmpTurnFooter = {}
    const requestStartedAtMs = finiteNumber(raw.requestStartedAtMs)
    const elapsedMs = finiteNumber(raw.elapsedMs)
    const cacheReadTokens = finiteNumber(raw.cacheReadTokens)
    const ttftMs = finiteNumber(raw.ttftMs)
    const durationMs = finiteNumber(raw.durationMs)
    if (requestStartedAtMs !== undefined && requestStartedAtMs > 0) footer.requestStartedAtMs = requestStartedAtMs
    if (elapsedMs !== undefined && elapsedMs > 0) footer.elapsedMs = elapsedMs
    if (hasDetail) {
        footer.inputTokens = inputTokens
        footer.outputTokens = outputTokens
        if (cacheReadTokens !== undefined && cacheReadTokens > 0) footer.cacheReadTokens = cacheReadTokens
        if (ttftMs !== undefined && ttftMs > 0) footer.ttftMs = ttftMs
        if (durationMs !== undefined && durationMs > 0) footer.durationMs = durationMs
    }
    if (turnTokens !== undefined && turnTokens > 0) footer.turnTokens = turnTokens
    if (turnCostUsd !== undefined && turnCostUsd > 0) footer.turnCostUsd = turnCostUsd
    return footer
}

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** omp `H`: compact duration. Sub-minute values round to 0.1s. */
export function formatOmpDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '0ms'
    if (ms < SECOND_MS) return `${Math.floor(ms)}ms`
    if (ms < MINUTE_MS) {
        const tenths = Math.round(ms / 100)
        return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : '1m'
    }
    if (ms < HOUR_MS) {
        const minutes = Math.floor(ms / MINUTE_MS)
        const seconds = Math.floor(ms % MINUTE_MS / SECOND_MS)
        return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`
    }
    if (ms < DAY_MS) {
        const hours = Math.floor(ms / HOUR_MS)
        const minutes = Math.floor(ms % HOUR_MS / MINUTE_MS)
        return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
    }
    const days = Math.floor(ms / DAY_MS)
    const hours = Math.floor(ms % DAY_MS / HOUR_MS)
    return hours > 0 ? `${days}d${hours}h` : `${days}d`
}

function formatScaledTokenCount(value: number): string {
    const text = value.toFixed(1)
    return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** omp `T`: compact token count. */
export function formatOmpTokenCount(value: number): string {
    if (value < 1000) return value.toString()
    if (value < 10_000) return `${formatScaledTokenCount(value / 1000)}K`
    if (value < 1_000_000) return `${Math.round(value / 1000)}K`
    if (value < 10_000_000) return `${formatScaledTokenCount(value / 1_000_000)}M`
    if (value < 1_000_000_000) return `${Math.round(value / 1_000_000)}M`
    if (value < 10_000_000_000) return `${formatScaledTokenCount(value / 1_000_000_000)}B`
    return `${Math.round(value / 1_000_000_000)}B`
}

/** Browser-local `HH:MM`, matching Tern's non-12-hour clock (`De(ts).slice(11, 16)`). */
export function formatOmpClock(timestampMs: number): string {
    const date = new Date(timestampMs)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
}

function formatDetail(footer: OmpTurnFooter, clock: (timestampMs: number) => string): string | undefined {
    if (footer.inputTokens === undefined || footer.outputTokens === undefined) return undefined
    const parts: string[] = []
    if (footer.requestStartedAtMs !== undefined && footer.requestStartedAtMs > 0) {
        parts.push(clock(footer.requestStartedAtMs))
    }
    if (footer.elapsedMs !== undefined && footer.elapsedMs > 0) {
        parts.push(`Δ ${formatOmpDuration(Math.round(footer.elapsedMs))}`)
    }
    parts.push(`in ${formatOmpTokenCount(footer.inputTokens)}`, `out ${formatOmpTokenCount(footer.outputTokens)}`)
    if (footer.cacheReadTokens !== undefined && footer.cacheReadTokens > 0) {
        parts.push(`cache ${formatOmpTokenCount(footer.cacheReadTokens)}`)
    }
    if (footer.ttftMs !== undefined && footer.ttftMs > 0) {
        parts.push(`ttft ${(footer.ttftMs / 1000).toFixed(1)}s`)
    }
    if (
        footer.durationMs !== undefined
        && footer.durationMs > 100
        && footer.outputTokens > 0
    ) {
        const perSecond = footer.outputTokens / footer.durationMs * 1000
        parts.push(`${perSecond.toFixed(1)} tok/s`)
    }
    return parts.join(' · ')
}

function formatTurn(footer: OmpTurnFooter): string | undefined {
    const tokens = footer.turnTokens
    const cost = footer.turnCostUsd
    if (!((tokens !== undefined && tokens > 0) || (cost !== undefined && cost > 0))) return undefined
    const parts: string[] = []
    if (footer.elapsedMs !== undefined && footer.elapsedMs > 0) {
        parts.push(formatOmpDuration(footer.elapsedMs))
    }
    parts.push(`${formatOmpTokenCount(tokens ?? 0)} tok`)
    if (cost !== undefined && cost > 0) {
        parts.push(cost < 0.005 ? '<$0.01' : `$${cost.toFixed(2)}`)
    }
    return `${parts.join(' · ')} this turn`
}

export function formatOmpTurnFooter(
    footer: OmpTurnFooter,
    clock: (timestampMs: number) => string = formatOmpClock
): string | null {
    const detail = formatDetail(footer, clock)
    const turn = formatTurn(footer)
    const line = [detail, turn].filter((part): part is string => Boolean(part)).join(' · ')
    return line.length > 0 ? line : null
}
