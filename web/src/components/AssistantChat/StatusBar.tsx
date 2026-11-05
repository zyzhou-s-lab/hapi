import {
    getCodexCollaborationModeLabel,
    getCopilotAgentModeLabel,
    getPermissionModeLabel,
    getPermissionModeTone,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol'
import type { PermissionModeTone } from '@hapi/protocol'
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useMemo, useState } from 'react'
import type { AgentState, CodexCollaborationMode, GitStatusFiles, OmpThinkingState, PermissionMode, ThreadGoal } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import {
    formatReasoningLabel,
    formatCompactReasoningLabel,
    getReasoningEffortForFlavor,
    shouldShowReasoningStatusLabel
} from '@/lib/codexStatusLabels'
import { isFastServiceTier } from './codexFastMode'
import { useTranslation } from '@/lib/use-translation'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import { useStatusVibing } from '@/hooks/useStatusVibing'

// Vibing messages for thinking state
const VIBING_MESSAGES = [
    "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing",
    "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing",
    "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering",
    "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
    "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting",
    "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting",
    "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching",
    "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring",
    "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering",
    "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating",
    "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating",
    "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking",
    "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
    "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring",
    "Wibbling", "Wizarding", "Working", "Wrangling"
]

const PERMISSION_TONE_CLASSES: Record<PermissionModeTone, string> = {
    neutral: 'text-[var(--app-hint)]',
    info: 'text-[var(--app-link)]',
    warning: 'text-[var(--app-badge-warning-text)]',
    danger: 'text-[var(--app-badge-error-text)]'
}

const CONTEXT_WARNING_THRESHOLD_PERCENT = 70
const CONTEXT_DANGER_THRESHOLD_PERCENT = 90

export function formatThinkingStatus(phase: string, elapsedSeconds: number): string {
    return `${phase} · ${Math.max(0, elapsedSeconds)}s`
}

function ThinkingClock(props: { phase: string; vibing: boolean }) {
    const [elapsedSeconds, setElapsedSeconds] = useState(0)
    const [vibingText, setVibingText] = useState<string | null>(null)
    useEffect(() => {
        const started = Date.now()
        setElapsedSeconds(0)
        setVibingText(props.vibing
            ? VIBING_MESSAGES[Math.floor(Math.random() * VIBING_MESSAGES.length)]!.toLowerCase() + '…'
            : null)
        const tick = () => setElapsedSeconds(Math.floor((Date.now() - started) / 1000))
        const id = window.setInterval(tick, 1000)
        return () => window.clearInterval(id)
    }, [props.vibing])
    return <>{vibingText ?? formatThinkingStatus(props.phase, elapsedSeconds)}</>
}

function getConnectionStatus(
    active: boolean,
    thinking: boolean,
    thinkingLabel: string,
    agentState: AgentState | null | undefined,
    voiceStatus: ConversationStatus | undefined,
    backgroundTaskCount: number,
    t: (key: string) => string
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
    const hasPermissions = agentState?.requests && Object.keys(agentState.requests).length > 0

    // Voice connecting takes priority
    if (voiceStatus === 'connecting') {
        return {
            text: t('voice.connecting'),
            color: 'text-[var(--app-link)]',
            dotColor: 'bg-[var(--app-link)]',
            isPulsing: true
        }
    }

    if (!active) {
        return {
            text: 'offline',
            color: 'text-[var(--app-hint)]',
            dotColor: 'bg-[var(--app-hint)]',
            isPulsing: false
        }
    }

    if (hasPermissions) {
        return {
            text: t('misc.permissionRequired'),
            color: 'text-[var(--app-badge-warning-text)]',
            dotColor: 'bg-[var(--app-badge-warning-text)]',
            isPulsing: true
        }
    }

    if (thinking) {
        return {
            text: thinkingLabel,
            color: 'text-[var(--app-link)]',
            dotColor: 'bg-[var(--app-link)]',
            isPulsing: true
        }
    }

    if (backgroundTaskCount > 0) {
        return {
            text: `${backgroundTaskCount} background task${backgroundTaskCount > 1 ? 's' : ''} running`,
            color: 'text-[var(--app-link)]',
            dotColor: 'bg-[var(--app-link)]',
            isPulsing: true
        }
    }

    return {
            text: 'online',
        color: 'text-[var(--app-badge-success-text)]',
        dotColor: 'bg-[var(--app-badge-success-text)]',
        isPulsing: false
    }
}

export function getContextWarning(contextSize: number, maxContextSize: number): { color: string } {
    const percentageUsed = (contextSize / maxContextSize) * 100

    if (percentageUsed >= CONTEXT_DANGER_THRESHOLD_PERCENT) {
        return { color: 'text-[var(--app-badge-error-text)]' }
    } else if (percentageUsed >= CONTEXT_WARNING_THRESHOLD_PERCENT) {
        return { color: 'text-[var(--app-badge-warning-text)]' }
    } else {
        return { color: 'text-[var(--app-hint)]' }
    }
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
}

function getContextPercentages(contextSize: number, maxContextSize: number): {
    usedPercentage: number
    remainingPercentage: number
} {
    const usedPercentage = Math.min(100, Math.max(0, Math.round((contextSize / maxContextSize) * 100)))
    return { usedPercentage, remainingPercentage: 100 - usedPercentage }
}

export function formatContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined): string {
    if (!maxContextSize) return `${formatTokenCount(contextSize)} used`
    const { usedPercentage } = getContextPercentages(contextSize, maxContextSize)
    return `${usedPercentage}% · ${formatTokenCount(contextSize)} / ${formatTokenCount(maxContextSize)}`
}

export function formatCompactContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined): string {
    if (!maxContextSize) return `ctx ${formatTokenCount(contextSize)}`
    const { remainingPercentage } = getContextPercentages(contextSize, maxContextSize)
    return `ctx ${formatTokenCount(maxContextSize)} (${remainingPercentage}% left)`
}

export function getContextUsageDetails(
    contextSize: number,
    maxContextSize: number | null | undefined,
    contextCacheRead: number | null | undefined
): {
    cacheRead: string | null
    used: string
    usedPercentage: number | null
    remaining: string | null
    remainingPercentage: number | null
} {
    if (!maxContextSize) {
        return {
            cacheRead: contextCacheRead && contextCacheRead > 0 ? formatTokenCount(contextCacheRead) : null,
            used: formatTokenCount(contextSize),
            usedPercentage: null,
            remaining: null,
            remainingPercentage: null
        }
    }

    const { usedPercentage, remainingPercentage } = getContextPercentages(contextSize, maxContextSize)
    return {
        cacheRead: contextCacheRead && contextCacheRead > 0 ? formatTokenCount(contextCacheRead) : null,
        used: formatTokenCount(contextSize),
        usedPercentage,
        remaining: formatTokenCount(Math.max(0, maxContextSize - contextSize)),
        remainingPercentage
    }
}

export function shouldShowCodexFastBadge(
    agentFlavor: string | null | undefined,
    serviceTier: string | null | undefined
): boolean {
    return agentFlavor === 'codex' && isFastServiceTier(serviceTier)
}
/** Cursor native ACP does not emit usage_update; hide the bar to avoid empty/misleading UI. */
export function shouldShowComposerStatusBar(agentFlavor: string | null | undefined): boolean {
    return agentFlavor !== 'cursor'
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    activityLabel?: string | null
    backgroundTaskCount?: number
    contextSize?: number
    contextCacheRead?: number
    contextWindow?: number | null
    /**
     * Model to use for the context-window fallback heuristic when
     * contextWindow is absent. Falls back to `model`. Callers pass the
     * usage-bearing message's own model here so local Claude sessions (whose
     * session.model is often null) still resolve a plausible window.
     */
    contextModel?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    ompThinkingState?: OmpThinkingState
    serviceTier?: string | null
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    threadGoal?: ThreadGoal | null
    copilotAgentMode?: import('@hapi/protocol').CopilotAgentMode
    agentFlavor?: string | null
    voiceStatus?: ConversationStatus
    gitBranch?: string | null
    gitStatus?: GitStatusFiles | null
    onViewFiles?: () => void
    hideContextUsage?: boolean
    hideRightStatus?: boolean
}) {
    const { t } = useTranslation()
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const vibing = useStatusVibing()
    const thinkingPhase = props.activityLabel?.trim() ? props.activityLabel.trim() : t('status.responding')
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, '', props.agentState, props.voiceStatus, props.backgroundTaskCount ?? 0, t),
        [props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount, t]
    )

    const contextHeuristicModel = props.contextModel ?? props.model
    const contextWarning = useMemo(
        () => {
            if (props.contextSize === undefined) return null
            const maxContextSize = props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor)
            if (!maxContextSize) return null
            return getContextWarning(props.contextSize, maxContextSize)
        },
        [props.contextSize, props.contextWindow, contextHeuristicModel, props.agentFlavor]
    )
    const contextUsageLabel = useMemo(() => {
        if (props.contextSize === undefined) return null
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor)
        return formatContextUsageLabel(props.contextSize, maxContextSize)
    }, [props.contextSize, props.contextWindow, contextHeuristicModel, props.agentFlavor])
    const compactContextUsageLabel = useMemo(() => {
        if (props.contextSize === undefined) return null
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor)
        return formatCompactContextUsageLabel(props.contextSize, maxContextSize)
    }, [props.contextSize, props.contextWindow, contextHeuristicModel, props.agentFlavor])
    const contextUsageDetails = useMemo(() => {
        if (props.contextSize === undefined) return null
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor)
        return getContextUsageDetails(props.contextSize, maxContextSize, props.contextCacheRead)
    }, [props.contextSize, props.contextCacheRead, props.contextWindow, contextHeuristicModel, props.agentFlavor])
    const contextUsedPercentage = contextUsageDetails?.usedPercentage ?? null

    const permissionMode = props.permissionMode
    // Copilot always shows permission (including Default) so model=auto sessions
    // still surface the bottom-right mode chip. Other flavors keep Codex-style
    // "hide default" parity.
    const displayPermissionMode = permissionMode
        && isPermissionModeAllowedForFlavor(permissionMode, props.agentFlavor)
        && (permissionMode !== 'default' || props.agentFlavor === 'copilot')
        ? permissionMode
        : null

    const permissionModeLabel = displayPermissionMode ? getPermissionModeLabel(displayPermissionMode) : null
    const permissionModeTone = displayPermissionMode ? getPermissionModeTone(displayPermissionMode) : null
    const permissionModeColor = permissionModeTone ? PERMISSION_TONE_CLASSES[permissionModeTone] : 'text-[var(--app-hint)]'
    const displayCollaborationMode = props.agentFlavor === 'codex' && props.collaborationMode === 'plan'
        ? props.collaborationMode
        : null
    const collaborationModeLabel = displayCollaborationMode
        ? getCodexCollaborationModeLabel(displayCollaborationMode)
        : null
    const displayCopilotAgentMode = props.agentFlavor === 'copilot'
        && props.copilotAgentMode
        && props.copilotAgentMode !== 'interactive'
        ? props.copilotAgentMode
        : null
    const copilotAgentModeLabel = displayCopilotAgentMode
        ? getCopilotAgentModeLabel(displayCopilotAgentMode)
        : null
    const reasoningEffort = getReasoningEffortForFlavor(
        props.agentFlavor,
        props.modelReasoningEffort,
        props.effort
    )
    const displaysReasoning = shouldShowReasoningStatusLabel(props.agentFlavor, reasoningEffort)
    const reasoningLabel = displaysReasoning
        ? formatReasoningLabel(reasoningEffort, headerMetadata.showLabels)
        : null
    const compactReasoningLabel = displaysReasoning
        ? formatCompactReasoningLabel(reasoningEffort)
        : null
    const ompThinkingLabel = props.agentFlavor === 'omp' && props.ompThinkingState?.configured
        ? props.ompThinkingState.configured === 'auto' && props.ompThinkingState.resolved
            ? `auto → ${props.ompThinkingState.resolved}`
            : props.ompThinkingState.configured
        : null
    const goalLabel = props.agentFlavor === 'codex' && props.threadGoal
        ? props.threadGoal.status === 'active'
            ? 'goal'
            : `goal ${props.threadGoal.status === 'budgetLimited' ? 'limited' : props.threadGoal.status}`
        : null
    const codexFastMode = shouldShowCodexFastBadge(props.agentFlavor, props.serviceTier)
    const gitSummary = useMemo(() => {
        const branch = props.gitStatus?.branch?.trim() || props.gitBranch?.trim() || null
        const stagedFiles = props.gitStatus?.stagedFiles ?? []
        const unstagedFiles = props.gitStatus?.unstagedFiles ?? []
        const allFiles = [...stagedFiles, ...unstagedFiles]
        const totalAdded = allFiles.reduce((sum, file) => sum + (file.linesAdded || 0), 0)
        const totalRemoved = allFiles.reduce((sum, file) => sum + (file.linesRemoved || 0), 0)
        const totalStaged = props.gitStatus?.totalStaged ?? stagedFiles.length
        const totalUnstaged = props.gitStatus?.totalUnstaged ?? unstagedFiles.length
        const changedCount = totalStaged + totalUnstaged
        if (!branch && changedCount === 0) return null
        return {
            branch,
            allFiles,
            totalAdded,
            totalRemoved,
            totalStaged,
            totalUnstaged,
            changedCount
        }
    }, [props.gitBranch, props.gitStatus])
    return (
        <div className="flex min-w-0 items-baseline justify-between gap-2 px-2 pb-1">
            <div className="flex min-w-0 items-baseline gap-2">
                <div className="relative top-px sm:top-0.5 flex shrink-0 items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`whitespace-nowrap text-xs ${connectionStatus.color}`}>
                        {props.thinking
                            ? <ThinkingClock phase={thinkingPhase} vibing={vibing.enabled} />
                            : connectionStatus.text}
                    </span>
                </div>
                {gitSummary ? (
                    <>
                        <span aria-hidden="true" className="text-[10px] text-[var(--app-hint)]/50">·</span>
                        <Popover.Root>
                            <Popover.Trigger asChild>
                                <button
                                    type="button"
                                    data-testid="statusbar-git-trigger"
                                    className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-1 py-0.5 text-[11px] leading-4 text-[var(--app-hint)] outline-none transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:ring-1 focus-visible:ring-[var(--app-link)]"
                                >
                                    <svg className="h-3 w-3 shrink-0 opacity-75" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="5" cy="4" r="1.75" />
                                        <circle cx="5" cy="12" r="1.75" />
                                        <circle cx="11" cy="6" r="1.75" />
                                        <path d="M5 5.75v4.5M11 7.75c0 2-1.5 2.5-6 2.5" />
                                    </svg>
                                    <span className="max-w-[140px] truncate font-mono text-[11px]">
                                        {gitSummary.branch ?? 'git'}
                                    </span>
                                    {gitSummary.totalAdded > 0 || gitSummary.totalRemoved > 0 ? (
                                        <span className="inline-flex items-center gap-1 font-mono text-[10px]">
                                            {gitSummary.totalAdded > 0 ? (
                                                <span className="text-emerald-500">+{gitSummary.totalAdded}</span>
                                            ) : null}
                                            {gitSummary.totalRemoved > 0 ? (
                                                <span className="text-rose-500">-{gitSummary.totalRemoved}</span>
                                            ) : null}
                                        </span>
                                    ) : gitSummary.changedCount > 0 ? (
                                        <span className="font-mono text-[10px] text-amber-500">
                                            {gitSummary.changedCount}
                                        </span>
                                    ) : (
                                        <span className="text-[10px] opacity-70">clean</span>
                                    )}
                                </button>
                            </Popover.Trigger>
                            <Popover.Portal>
                                <Popover.Content
                                    side="top"
                                    align="start"
                                    sideOffset={6}
                                    collisionPadding={8}
                                    className="z-50 w-64 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5 shadow-lg"
                                >
                                    <div className="flex flex-col gap-2 text-xs text-[var(--app-fg)]">
                                        <div className="flex items-center justify-between gap-2 border-b border-[var(--app-divider)] pb-1.5">
                                            <span className="truncate font-mono text-[11px] font-semibold">
                                                {gitSummary.branch ?? 'working tree'}
                                            </span>
                                            <span className="shrink-0 font-mono text-[10px] text-[var(--app-hint)]">
                                                {gitSummary.changedCount > 0
                                                    ? `${gitSummary.changedCount} changed`
                                                    : 'clean'}
                                            </span>
                                        </div>
                                        {gitSummary.allFiles.length > 0 ? (
                                            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                                                {gitSummary.allFiles.slice(0, 6).map((file) => (
                                                    <div key={`${file.isStaged ? 's' : 'u'}:${file.fullPath}`} className="flex items-center justify-between gap-2 text-[11px]">
                                                        <span className="min-w-0 truncate font-mono text-[var(--app-fg)]">
                                                            {file.fullPath || file.fileName}
                                                        </span>
                                                        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px]">
                                                            {file.linesAdded > 0 ? (
                                                                <span className="text-emerald-500">+{file.linesAdded}</span>
                                                            ) : null}
                                                            {file.linesRemoved > 0 ? (
                                                                <span className="text-rose-500">-{file.linesRemoved}</span>
                                                            ) : null}
                                                        </span>
                                                    </div>
                                                ))}
                                                {gitSummary.allFiles.length > 6 ? (
                                                    <span className="text-[10px] text-[var(--app-hint)]">
                                                        +{gitSummary.allFiles.length - 6} more…
                                                    </span>
                                                ) : null}
                                            </div>
                                        ) : (
                                            <span className="text-[11px] text-[var(--app-hint)]">
                                                Working tree clean
                                            </span>
                                        )}
                                        {props.onViewFiles ? (
                                            <button
                                                type="button"
                                                onClick={props.onViewFiles}
                                                className="mt-0.5 inline-flex items-center justify-center rounded-lg bg-[var(--app-subtle-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-border)]"
                                            >
                                                {t('files.title')}
                                            </button>
                                        ) : null}
                                    </div>
                                </Popover.Content>
                            </Popover.Portal>
                        </Popover.Root>
                    </>
                ) : null}
                {!props.hideContextUsage && contextUsageLabel ? (
                    <Popover.Root>
                        <Popover.Trigger asChild>
                            <button
                                type="button"
                                aria-label={t('misc.contextDetails')}
                                className={`min-w-0 cursor-pointer whitespace-nowrap rounded-sm bg-transparent p-0 text-[10px] leading-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${contextWarning?.color ?? 'text-[var(--app-hint)]'}`}
                            >
                                <span className="sm:hidden">{compactContextUsageLabel}</span>
                                <span className="hidden items-center gap-2 sm:inline-flex">
                                    {contextUsedPercentage !== null ? (
                                        <span
                                            aria-hidden="true"
                                            className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-[var(--app-link-muted)]"
                                        >
                                            <span
                                                className="block h-full rounded-full bg-current"
                                                style={{ width: `${contextUsedPercentage}%` }}
                                            />
                                        </span>
                                    ) : null}
                                    <span>{contextUsageLabel}</span>
                                </span>
                            </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                            <Popover.Content
                                side="top"
                                align="start"
                                sideOffset={6}
                                collisionPadding={8}
                                className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                            >
                                <div className="flex max-w-[min(22rem,calc(100vw-1rem))] flex-col gap-1 text-xs leading-tight text-[var(--app-fg)]">
                                    {contextUsageDetails?.cacheRead ? (
                                        <span className="break-words">
                                            {t('misc.contextCache', { value: contextUsageDetails.cacheRead })}
                                        </span>
                                    ) : null}
                                    <span className="break-words">
                                        {contextUsageDetails?.usedPercentage === null
                                            ? t('misc.contextUsedTokens', { value: contextUsageDetails.used })
                                            : t('misc.contextUsed', {
                                                value: contextUsageDetails?.used ?? '',
                                                percent: contextUsageDetails?.usedPercentage ?? 0
                                            })}
                                    </span>
                                    {contextUsageDetails?.remaining && contextUsageDetails.remainingPercentage !== null ? (
                                        <span className="break-words">
                                            {t('misc.contextRemaining', {
                                                value: contextUsageDetails.remaining,
                                                percent: contextUsageDetails.remainingPercentage
                                            })}
                                        </span>
                                    ) : null}
                                </div>
                            </Popover.Content>
                        </Popover.Portal>
                    </Popover.Root>
                ) : null}
            </div>

            <div className="flex min-w-0 shrink-0 items-baseline gap-2">
                {!props.hideRightStatus ? (
                    <>
                        {reasoningLabel ? (
                            <span className="whitespace-nowrap text-xs text-[var(--app-hint)]">
                                <span className="sm:hidden">{compactReasoningLabel}</span>
                                <span className="hidden sm:inline">{reasoningLabel}</span>
                            </span>
                        ) : null}
                        {ompThinkingLabel ? (
                            <span className="whitespace-nowrap text-xs text-[var(--app-hint)]">
                                {ompThinkingLabel}
                            </span>
                        ) : null}
                        {goalLabel ? (
                            <span className="whitespace-nowrap text-xs text-[var(--app-hint)]">
                                {goalLabel}
                            </span>
                        ) : null}
                        {codexFastMode ? (
                            <span className="whitespace-nowrap text-xs text-[var(--app-badge-success-text)]">
                                fast
                            </span>
                        ) : null}
                        {collaborationModeLabel ? (
                            <span className="whitespace-nowrap text-xs text-[var(--app-link)]">
                                {collaborationModeLabel}
                            </span>
                        ) : null}
                        {copilotAgentModeLabel ? (
                            <span className="whitespace-nowrap text-xs text-[var(--app-link)]">
                                {copilotAgentModeLabel}
                            </span>
                        ) : null}
                        {displayPermissionMode ? (
                            <span className={`whitespace-nowrap text-xs ${permissionModeColor}`}>
                                {permissionModeLabel}
                            </span>
                        ) : null}
                    </>
                ) : null}
            </div>
        </div>
    )
}
