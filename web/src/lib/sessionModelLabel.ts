import { getAgyModelLabel, getClaudeModelLabel } from '@hapi/protocol'
import type { UsageSnapshot } from '@hapi/protocol/schemas'

type SessionModelSource = {
    model?: string | null
}

export function formatUsageSnapshotLabel(
    snapshot: UsageSnapshot | null | undefined,
    remainingPrefix: string
): string | null {
    if (!snapshot) return null
    const progress = snapshot.metrics.find((metric) => metric.type === 'progress')
    if (progress?.type === 'progress') {
        const remaining = Math.max(0, progress.limit - progress.used)
        const value = progress.unit === 'percent' ? `${remaining}%` : remaining.toLocaleString('en-US')
        return `${snapshot.displayName} · ${progress.label} ${remainingPrefix}${value}`
    }
    const text = snapshot.metrics.find((metric) => metric.type === 'text')
    return text?.type === 'text'
        ? `${snapshot.displayName} · ${text.label} ${text.value}`
        : snapshot.displayName
}

export type SessionModelLabel = {
    key: 'session.item.model'
    value: string
}

function getModelLabel(model: string): string | null {
    return getAgyModelLabel(model) ?? getClaudeModelLabel(model)
}

export function getSessionModelLabel(
    session: SessionModelSource,
    availableModels?: ReadonlyArray<{ modelId: string; name?: string }>
): SessionModelLabel | null {
    const explicitModel = typeof session.model === 'string' ? session.model.trim() : ''
    if (explicitModel) {
        const dynamicLabel = availableModels?.find((model) => model.modelId === explicitModel)?.name
        return {
            key: 'session.item.model',
            value: dynamicLabel ?? getModelLabel(explicitModel) ?? explicitModel
        }
    }

    return null
}
