import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { getSessionListSelectionNavigation } from '@/lib/sessionNavigation'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { CardFrame, registerWorkCards, type WorkCardContext, type WorkCardDefinition } from './WorkCardHost'
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
        onError: () => setCreateFailed(true),
    })
    const selected = lineIdOf(props.ctx)
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
            {machines.length === 0 ? <p className="mt-3 text-xs text-[var(--app-hint)]">{t('work.noMachines')}</p> : (
                <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
                    <input className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('work.lineName')} />
                    <input className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t('work.lineGoal')} />
                    <select className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={machineId} onChange={(event) => setMachineId(event.target.value)}>
                        <option value="">{t('work.pickMachine')}</option>
                        {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.metadata?.displayName || machine.id}</option>)}
                    </select>
                    <input className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm" value={path} onChange={(event) => setPath(event.target.value)} placeholder={t('work.primaryPath')} />
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

registerWorkCards([lineList, lineHeader, focus, directories, inbox, sessionsCard, continueCard])
