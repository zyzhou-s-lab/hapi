import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { getSessionListSelectionNavigation } from '@/lib/sessionNavigation'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { CardFrame, registerWorkCards, type WorkCardContext, type WorkCardDefinition } from './WorkCardHost'
import { watchCardTopic } from './cardTopics'
import { workCardMapPrefix } from './useWorkMap'

function useBench(ctx: WorkCardContext) {
    return ctx.bench
}

function lineIdOf(ctx: WorkCardContext): string {
    return ctx.view.kind === 'line' ? ctx.view.lineId : ''
}

function useMapRefresh() {
    const queryClient = useQueryClient()
    return async () => { await queryClient.invalidateQueries({ queryKey: workCardMapPrefix }) }
}

const onLine = (ctx: WorkCardContext) => ctx.view.kind === 'line' && ctx.view.lineId.length > 0

const lineList: WorkCardDefinition = {
    id: 'workbench.line-list',
    titleKey: 'work.lines',
    size: 'rail',
    source: { kind: 'work-model' },
    Component: ({ ctx }) => <LineList ctx={ctx} />,
}

function LineList(props: { ctx: WorkCardContext }): ReactNode {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { machines } = useMachines(api, true)
    const bench = useBench(props.ctx)
    const refresh = useMapRefresh()
    const [name, setName] = useState('')
    const [goal, setGoal] = useState('')
    const [path, setPath] = useState('')
    const [machineId, setMachineId] = useState('')
    const [createFailed, setCreateFailed] = useState(false)
    const create = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error('API unavailable')
            const created = await api.createWorkLine({ name, goal: goal.trim() || null, primaryMachineId: machineId, primaryPath: path })
            return created.line.id
        },
        onSuccess: async (id) => {
            setCreateFailed(false)
            setName('')
            setGoal('')
            setPath('')
            setMachineId('')
            await refresh()
            await navigate({ to: '/work', search: { line: id } })
        },
        onError: (error) => {
            console.error(error)
            setCreateFailed(true)
        },
    })
    const selected = lineIdOf(props.ctx)
    const listed = machines.filter((machine) => machine != null)
    return (
        <CardFrame title={t('work.lines')}>
            <ul className="flex flex-col gap-1">
                {bench.lines.map((line) => (
                    <li key={line.id}>
                        <button type="button" className="w-full truncate text-left text-sm text-[var(--app-fg)]" onClick={() => navigate({ to: '/work', search: { line: line.id } })}>
                            {line.name}{line.id === selected ? ' ·' : ''} <span className="text-[var(--app-hint)]">{line.sessionCount}</span>
                        </button>
                    </li>
                ))}
            </ul>
            <button type="button" className="mt-3 text-sm text-[var(--app-link)]" onClick={() => navigate({ to: '/work', search: { inbox: true } })}>
                {t('work.inbox')} ({bench.inboxDirectoryCount})
            </button>
            {listed.length === 0 ? <p className="mt-3 text-xs text-[var(--app-hint)]">{t('work.noMachines')}</p> : (
                <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); setCreateFailed(false); create.mutate() }}>
                    <input className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={name} onChange={(event) => { setCreateFailed(false); setName(event.target.value) }} placeholder={t('work.lineName')} />
                    <input className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={goal} onChange={(event) => { setCreateFailed(false); setGoal(event.target.value) }} placeholder={t('work.lineGoal')} />
                    <select className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={machineId} onChange={(event) => { setCreateFailed(false); setMachineId(event.target.value) }}>
                        <option value="">{t('work.pickMachine')}</option>
                        {listed.map((machine) => <option key={machine.id} value={machine.id}>{machine.metadata?.displayName || machine.id}</option>)}
                    </select>
                    <input className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={path} onChange={(event) => { setCreateFailed(false); setPath(event.target.value) }} placeholder={t('work.primaryPath')} />
                    <button type="submit" className="text-sm text-[var(--app-link)]" disabled={create.isPending || !name || !machineId || !path}>{t('work.createLine')}</button>
                    {createFailed ? <p className="text-sm text-red-600">{t('work.createLineFailed')}</p> : null}
                </form>
            )}
        </CardFrame>
    )
}

const lineHeader: WorkCardDefinition = {
    id: 'workbench.line-header',
    titleKey: 'work.lineHeader',
    size: 'main',
    source: { kind: 'work-model' },
    visible: onLine,
    Component: ({ ctx }) => <LineHeader ctx={ctx} />,
}

function LineHeader(props: { ctx: WorkCardContext }): ReactNode {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const bench = useBench(props.ctx)
    const refresh = useMapRefresh()
    const line = bench.lines.find((item) => item.id === lineIdOf(props.ctx))
    const remove = useMutation({
        mutationFn: async () => {
            if (!api || !line) throw new Error('API unavailable')
            await api.deleteWorkLine(line.id)
        },
        onSuccess: async () => {
            await refresh()
            await navigate({ to: '/work', search: {} })
        },
    })
    if (!line) return null
    return (
        <CardFrame title={line.name}>
            {line.goal ? <p className="text-sm text-[var(--app-fg)]">{line.goal}</p> : null}
            <p className="text-xs text-[var(--app-hint)]">{line.primaryMachineId} · {line.primaryPath}</p>
            <button type="button" className="mt-2 text-xs text-[var(--app-hint)]" disabled={remove.isPending} onClick={() => { if (!window.confirm(t('work.deleteLineConfirm', { name: line.name }))) return; remove.mutate() }}>{t('work.deleteLine')}</button>
        </CardFrame>
    )
}

const focus: WorkCardDefinition = {
    id: 'workbench.focus',
    titleKey: 'work.focus',
    size: 'main',
    source: { kind: 'work-model' },
    visible: onLine,
    Component: ({ ctx }) => {
        const { t } = useTranslation()
        const navigate = useNavigate()
        const bench = useBench(ctx)
        const row = bench.focus(lineIdOf(ctx))
        return (
            <CardFrame title={t('work.focus')}>
                {row ? (
                    <button type="button" className="text-left text-sm text-[var(--app-fg)]" onClick={() => navigate(getSessionListSelectionNavigation(row.id))}>{row.title}</button>
                ) : <p className="text-sm text-[var(--app-hint)]">{t('work.focusEmpty')}</p>}
            </CardFrame>
        )
    },
}

const directories: WorkCardDefinition = {
    id: 'workbench.directories',
    titleKey: 'work.directories',
    size: 'main',
    source: { kind: 'work-model' },
    visible: onLine,
    Component: ({ ctx }) => {
        const { t } = useTranslation()
        const bench = useBench(ctx)
        const rows = bench.lineDirectories(lineIdOf(ctx))
        return (
            <CardFrame title={t('work.directories')}>
                <ul>
                    {rows.map((row) => (
                        <li key={row.directoryKey} className="truncate text-sm text-[var(--app-fg)]">{row.path} <span className="text-[var(--app-hint)]">{row.sessionCount}</span></li>
                    ))}
                </ul>
            </CardFrame>
        )
    },
}

const inbox: WorkCardDefinition = {
    id: 'workbench.inbox',
    titleKey: 'work.inbox',
    size: 'main',
    source: { kind: 'work-model' },
    visible: (ctx) => ctx.view.kind === 'inbox',
    Component: ({ ctx }) => <Inbox ctx={ctx} />,
}

function Inbox(props: { ctx: WorkCardContext }): ReactNode {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const bench = useBench(props.ctx)
    const refresh = useMapRefresh()
    const assignDirectory = useMutation({
        mutationFn: async (input: { directoryKey: string; lineId: string }) => {
            if (!api) throw new Error('API unavailable')
            await api.putWorkDirectory({ directoryKey: input.directoryKey, mode: 'line', lineId: input.lineId })
        },
        onSuccess: refresh,
    })
    const assignSession = useMutation({
        mutationFn: async (input: { sessionId: string; lineId: string }) => {
            if (!api) throw new Error('API unavailable')
            await api.putWorkSession({ sessionId: input.sessionId, state: 'line', lineId: input.lineId })
        },
        onSuccess: refresh,
    })
    const empty = bench.inboxDirectories.length === 0 && bench.inboxSessions.length === 0
    return (
        <CardFrame title={t('work.inbox')}>
            {empty ? <p className="text-sm text-[var(--app-hint)]">{t('work.inboxEmpty')}</p> : (
                <ul className="flex flex-col gap-2">
                    {bench.inboxDirectories.map((row) => (
                        <li key={row.directoryKey} className="text-sm text-[var(--app-fg)]">
                            <span className="block truncate">{row.path}</span>
                            <span className="flex flex-wrap gap-2">
                                {bench.lines.map((line) => (
                                    <button key={line.id} type="button" className="text-xs text-[var(--app-link)]" disabled={assignDirectory.isPending} onClick={() => assignDirectory.mutate({ directoryKey: row.directoryKey, lineId: line.id })}>
                                        {t('work.assignTo', { name: line.name })}
                                    </button>
                                ))}
                            </span>
                        </li>
                    ))}
                    {bench.inboxSessions.map((row) => (
                        <li key={row.id} className="text-sm text-[var(--app-fg)]">
                            <span className="block truncate">{row.title}</span>
                            <span className="flex flex-wrap gap-2">
                                {bench.lines.map((line) => (
                                    <button key={line.id} type="button" className="text-xs text-[var(--app-link)]" disabled={assignSession.isPending} onClick={() => assignSession.mutate({ sessionId: row.id, lineId: line.id })}>
                                        {t('work.assignTo', { name: line.name })}
                                    </button>
                                ))}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </CardFrame>
    )
}

const sessionsCard: WorkCardDefinition = {
    id: 'workbench.sessions',
    titleKey: 'work.sessions',
    size: 'side',
    source: { kind: 'work-model' },
    visible: onLine,
    Component: ({ ctx }) => {
        const { t } = useTranslation()
        const navigate = useNavigate()
        const bench = useBench(ctx)
        const rows = bench.lineSessions(lineIdOf(ctx))
        return (
            <CardFrame title={t('work.sessions')}>
                {rows.length === 0 ? <p className="text-sm text-[var(--app-hint)]">{t('work.sessionsEmpty')}</p> : (
                    <ul>
                        {rows.map((row) => (
                            <li key={row.id}>
                                <button type="button" className="truncate text-left text-sm text-[var(--app-fg)]" onClick={() => navigate(getSessionListSelectionNavigation(row.id))}>{row.title}</button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardFrame>
        )
    },
}

const continueCard: WorkCardDefinition = {
    id: 'workbench.continue',
    titleKey: 'work.continue',
    size: 'side',
    source: { kind: 'work-model' },
    visible: onLine,
    Component: ({ ctx }) => {
        const { t } = useTranslation()
        const navigate = useNavigate()
        const bench = useBench(ctx)
        const line = bench.lines.find((item) => item.id === lineIdOf(ctx))
        if (!line) return null
        return (
            <CardFrame title={t('work.continue')}>
                <button
                    type="button"
                    className="text-sm text-[var(--app-link)]"
                    onClick={() => navigate({ to: '/sessions/new', search: { directory: line.primaryPath, machineId: line.primaryMachineId } })}
                >
                    {t('work.continueHere')}
                </button>
            </CardFrame>
        )
    },
}
function HypothesisCard(props: { ctx: WorkCardContext }): ReactNode {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const refresh = useMapRefresh()
    const lineId = lineIdOf(props.ctx)
    const line = useBench(props.ctx).lines.find((item) => item.id === lineId)
    const stored = line?.hypothesis ?? ''
    const [draft, setDraft] = useState(stored)
    const [failed, setFailed] = useState(false)
    useEffect(() => { setDraft(stored) }, [stored])
    const save = useMutation({
        mutationFn: async () => {
            if (!api || !lineId) throw new Error('API unavailable')
            await api.putWorkHypothesis(lineId, draft.trim() ? draft : null)
        },
        onSuccess: () => { setFailed(false); void refresh() },
        onError: () => setFailed(true),
    })
    return (
        <CardFrame title={t('work.hypothesis')}>
            <textarea className="mt-3 min-h-24 w-full rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={draft} onChange={(event) => { setFailed(false); setDraft(event.target.value) }} placeholder={t('work.hypothesisPlaceholder')} />
            <button type="button" className="mt-2 text-sm text-[var(--app-link)]" disabled={!lineId || save.isPending || draft === (line?.hypothesis ?? '')} onClick={() => save.mutate()}>{t('work.saveHypothesis')}</button>
            {failed ? <p className="text-sm text-red-600">{t('work.saveHypothesisFailed')}</p> : null}
        </CardFrame>
    )
}

function ReferencesCard(props: { ctx: WorkCardContext }): ReactNode {
    const { t } = useTranslation()
    const { api, user } = useAppContext()
    const lineId = lineIdOf(props.ctx)
    const query = useQuery({
        queryKey: ['work-references', user.id, lineId],
        enabled: Boolean(api && lineId),
        queryFn: () => api!.getWorkReferences(lineId),
    })
    useEffect(() => {
        if (!lineId) return
        return watchCardTopic('work-map', user.id, ['work-references', user.id, lineId])
    }, [lineId, user.id])
    const [format, setFormat] = useState<'apa7' | 'vancouver'>('apa7')
    const [citation, setCitation] = useState('')
    const [failed, setFailed] = useState(false)
    const add = useMutation({
        mutationFn: async () => {
            if (!api || !lineId) throw new Error('API unavailable')
            await api.createWorkReference(lineId, { format, citation })
        },
        onSuccess: () => { setFailed(false); setCitation(''); void query.refetch() },
        onError: () => setFailed(true),
    })
    const remove = useMutation({
        mutationFn: async (referenceId: string) => {
            if (!api || !lineId) throw new Error('API unavailable')
            await api.deleteWorkReference(lineId, referenceId)
        },
        onSuccess: () => { void query.refetch() },
    })
    const references = query.data?.references ?? []
    return (
        <CardFrame title={t('work.references')}>
            {references.length === 0 ? <p className="mt-3 text-xs text-[var(--app-hint)]">{t('work.noReferences')}</p> : (
                <ul className="mt-3 flex flex-col gap-2">
                    {references.map((reference) => (
                        <li key={reference.id} className="flex items-start gap-2 text-sm">
                            <span className="min-w-0 flex-1">{reference.citation}</span>
                            <button type="button" className="shrink-0 text-xs text-[var(--app-hint)]" onClick={() => remove.mutate(reference.id)}>{t('work.removeReference')}</button>
                        </li>
                    ))}
                </ul>
            )}
            <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); setFailed(false); add.mutate() }}>
                <select className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={format} onChange={(event) => setFormat(event.target.value === 'vancouver' ? 'vancouver' : 'apa7')}>
                    <option value="apa7">{t('work.formatApa7')}</option>
                    <option value="vancouver">{t('work.formatVancouver')}</option>
                </select>
                <textarea className="min-h-16 w-full rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={citation} onChange={(event) => { setFailed(false); setCitation(event.target.value) }} placeholder={t('work.citationPlaceholder')} />
                <button type="submit" className="text-sm text-[var(--app-link)]" disabled={!lineId || add.isPending || !citation.trim()}>{t('work.addReference')}</button>
                {failed ? <p className="text-sm text-red-600">{t('work.addReferenceFailed')}</p> : null}
            </form>
        </CardFrame>
    )
}

const hypothesisCard: WorkCardDefinition = {
    id: 'workbench.hypothesis',
    titleKey: 'work.hypothesis',
    size: 'main',
    source: { kind: 'work-model' },
    visible: (ctx) => ctx.view.kind === 'line',
    Component: HypothesisCard,
}

const referencesCard: WorkCardDefinition = {
    id: 'workbench.references',
    titleKey: 'work.references',
    size: 'side',
    source: { kind: 'work-model' },
    visible: (ctx) => ctx.view.kind === 'line',
    Component: ReferencesCard,
}
registerWorkCards([lineList, lineHeader, hypothesisCard, focus, directories, inbox, sessionsCard, continueCard, referencesCard])
