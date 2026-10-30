import { Component, useEffect, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'
import { watchCardTopic } from './cardTopics'
import { deriveWork, type WorkMapData, type WorkModel } from './deriveWork'
import { mergeLayout, slotsForRegion, visiblePollInterval, type WorkCardSize, type WorkLayout, type WorkLayoutSlot, type WorkSurface } from './layout'
import { overviewLayout } from './defaultLayouts'
import { useWorkMap, workMapKey } from './useWorkMap'

export type WorkView = { kind: 'overview' } | { kind: 'line'; lineId: string } | { kind: 'inbox' }

export type WorkCardContext = {
    sessions: SessionSummary[]
    surface: WorkSurface
    view: WorkView
    slot: WorkLayoutSlot
    model: WorkModel | null
    query: { data: unknown; error: string | null; isLoading: boolean; refetch: () => void }
}

export type WorkCardDefinition = {
    id: string
    titleKey: string
    size: WorkCardSize
    source: { kind: 'work-model' } | {
        kind: 'query'
        queryKey: readonly unknown[]
        queryFn: (args: { signal: AbortSignal; accountId: number; view: WorkView }) => Promise<unknown>
        topic?: string
        pollMs?: number
    }
    Component: (props: { card: WorkCardDefinition; ctx: WorkCardContext }) => ReactNode
    visible?: (ctx: WorkCardContext) => boolean
}

const registry = new Map<string, WorkCardDefinition>()

export function registerWorkCards(cards: WorkCardDefinition[]): void {
    for (const card of cards) registry.set(card.id, card)
}

export function workCardRegistry(): ReadonlyMap<string, { size: WorkCardSize }> {
    return registry
}

export function WorkCardHost(props: {
    surface: WorkSurface
    view: WorkView
    sessions: SessionSummary[]
    api: ApiClient | null
    layoutFor?: (surface: WorkSurface) => WorkLayout
}): ReactNode {
    const { user } = useAppContext()
    const { t } = useTranslation()
    const mapQuery = useWorkMap(props.api)
    const model = useMemo(() => deriveWork(
        props.sessions,
        mapQuery.map,
        getSessionTitle,
        (session) => session.metadata?.host ?? session.metadata?.machineId ?? '',
    ), [mapQuery.map, props.sessions])
    useEffect(() => {
        return watchCardTopic('work-map', user.id, workMapKey)
    }, [user.id])
    const saved = useQuery({
        queryKey: ['work', 'layout', props.surface],
        queryFn: async () => {
            if (!props.api) throw new Error('API unavailable')
            return await props.api.getWorkLayout(props.surface)
        },
        enabled: Boolean(props.api),
    })
    const defaults = props.layoutFor?.(props.surface) ?? overviewLayout
    const layout = mergeLayout(saved.data?.source === 'saved' ? saved.data.layout : null, defaults)
    const regions = Object.keys(layout.regions)
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            {regions.map((region) => (
                <WorkRegion
                    key={region}
                    region={region}
                    slots={slotsForRegion(layout, region, registry)}
                    surface={props.surface}
                    view={props.view}
                    sessions={props.sessions}
                    api={props.api}
                    accountId={user.id}
                    model={model}
                    mapError={mapQuery.error}
                    refetchMap={() => { void mapQuery.refetch() }}
                    retryLabel={t('work.retry')}
                    failedMessage={t('work.cardFailed')}
                />
            ))}
        </div>
    )
}

function WorkRegion(props: {
    region: string
    slots: WorkLayoutSlot[]
    surface: WorkSurface
    view: WorkView
    sessions: SessionSummary[]
    api: ApiClient | null
    accountId: number
    model: WorkModel
    mapError: string | null
    refetchMap: () => void
    retryLabel: string
    failedMessage: string
}): ReactNode {
    const { t } = useTranslation()
    if (props.slots.length === 0) return null
    const grid = props.region === 'stats'
    return (
        <div className={grid ? 'grid grid-cols-2 gap-2 md:grid-cols-4' : 'flex min-h-0 flex-col gap-3'}>
            {props.slots.map((slot) => {
                const card = registry.get(slot.cardId)
                if (!card) return null
                return (
                    <CardErrorBoundary key={slot.cardId} title={t(card.titleKey)} message={props.failedMessage} retryLabel={props.retryLabel}>
                        <CardSlot card={card} slot={slot} surface={props.surface} view={props.view} sessions={props.sessions} api={props.api} accountId={props.accountId} model={props.model} mapError={props.mapError} refetchMap={props.refetchMap} />
                    </CardErrorBoundary>
                )
            })}
        </div>
    )
}

function CardSlot(props: {
    card: WorkCardDefinition
    slot: WorkLayoutSlot
    surface: WorkSurface
    view: WorkView
    sessions: SessionSummary[]
    api: ApiClient | null
    accountId: number
    model: WorkModel
    mapError: string | null
    refetchMap: () => void
}): ReactNode {
    const { t } = useTranslation()
    const querySource = props.card.source.kind === 'query' ? props.card.source : null
    useEffect(() => {
        if (!querySource?.topic) return
        return watchCardTopic(querySource.topic, props.accountId, querySource.queryKey)
    }, [props.accountId, querySource])
    const polled = useQuery({
        queryKey: querySource?.queryKey ?? ['work', 'card', 'idle', props.card.id],
        queryFn: ({ signal }) => querySource!.queryFn({ signal, accountId: props.accountId, view: props.view }),
        enabled: Boolean(querySource),
        refetchInterval: () => visiblePollInterval(querySource?.pollMs, document.visibilityState === 'visible'),
        refetchIntervalInBackground: false,
    })
    useEffect(() => {
        if (!querySource?.pollMs) return
        const onShow = () => {
            if (document.visibilityState === 'visible') void polled.refetch()
        }
        document.addEventListener('visibilitychange', onShow)
        return () => document.removeEventListener('visibilitychange', onShow)
    }, [polled.refetch, querySource?.pollMs])
    const ctx: WorkCardContext = {
        sessions: props.sessions,
        surface: props.surface,
        view: props.view,
        slot: props.slot,
        model: props.card.source.kind === 'work-model' ? props.model : null,
        query: {
            data: polled.data,
            error: polled.error instanceof Error ? polled.error.message : null,
            isLoading: polled.isLoading,
            refetch: () => { void polled.refetch() },
        },
    }
    if (props.card.visible && !props.card.visible(ctx)) return null
    const failed = querySource ? ctx.query.error : props.mapError
    if (failed) {
        return (
            <CardFrame title={t(props.card.titleKey)}>
                <p className="text-sm text-red-600">{t('work.cardFailed')}</p>
                <button type="button" className="text-sm text-[var(--app-link)]" onClick={() => { if (querySource) ctx.query.refetch(); else props.refetchMap() }}>{t('work.retry')}</button>
            </CardFrame>
        )
    }
    const Card = props.card.Component
    return <Card card={props.card} ctx={ctx} />
}

export function CardFrame(props: { title: string; children: ReactNode }): ReactNode {
    return (
        <section className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3">
            <h3 className="text-xs font-medium text-[var(--app-hint)]">{props.title}</h3>
            <div className="mt-1">{props.children}</div>
        </section>
    )
}

class CardErrorBoundary extends Component<{ title: string; message: string; retryLabel: string; children: ReactNode }, { failed: boolean }> {
    state = { failed: false }

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true }
    }

    render(): ReactNode {
        if (!this.state.failed) return this.props.children
        return (
            <section className="rounded-lg border border-[var(--app-divider)] p-3 text-sm text-red-600">
                <p>{this.props.title}</p>
                <p>{this.props.message}</p>
                <button type="button" className="text-sm text-[var(--app-link)]" onClick={() => this.setState({ failed: false })}>{this.props.retryLabel}</button>
            </section>
        )
    }
}
