import { useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { SessionHeader } from '@/components/SessionHeader'
import { SessionReadBanner } from '@/components/SessionReadBanner'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSession } from '@/hooks/queries/useSession'
import { useSessionConfig } from '@/hooks/queries/useSessionConfig'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { useTranslation } from '@/lib/use-translation'
import { formatSessionConfigError } from '@/lib/sessionConfigError'
import { encodeBase64 } from '@/lib/utils'
import {
    agentsSection,
    hooksSection,
    mcpSection,
    promptSection,
    skillsSection,
    type InventoryRow,
    type InventorySection,
} from '@/lib/sessionInventoryView'


function promptCopy(code: string | undefined, t: (key: string) => string): string | null {
    if (!code) return null
    const key = code.startsWith('session.config.') ? code : `session.config.prompt.note.${code}`
    const translated = t(key)
    return translated === key ? code : translated
}

function promptPathLabel(detail: string, t: (key: string, params?: Record<string, string | number>) => string): string {
    const segment = /^segment:(\d+)$/.exec(detail)
    if (!segment?.[1]) return detail
    return t('session.config.prompt.segment', { n: segment[1] })
}

function promptTitle(title: string, t: (key: string) => string): string {
    const keys: Record<string, string> = {
        'append-system-prompt': 'session.config.prompt.channel.append',
        'system-prompt': 'session.config.prompt.channel.replace',
        developer_instructions: 'session.config.prompt.channel.developer',
        'first-message': 'session.config.prompt.firstMessage',
        'plan-mode': 'session.config.prompt.planMode',
        'hapi-instructions.md': 'session.config.prompt.hapiInstructions',
        'cursor-account': 'session.config.prompt.note.cursor-account',
        'remote-url': 'session.config.prompt.note.remote-url',
        claudeMd: 'session.config.prompt.claudeMd',
    }
    const key = keys[title]
    if (!key) return title
    const translated = t(key)
    return translated === key ? title : translated
}

function sectionMessage(section: InventorySection, t: (key: string) => string, emptyKey: string): string | null {
    switch (section.status) {
        case 'unreported':
            return t('session.config.unreported')
        case 'empty':
            return t(emptyKey)
        case 'none':
            return section.note ? promptCopy(section.note, t) : t('session.config.hooks.none')
        case 'catalogUnavailable':
            return t('session.config.skills.catalogUnavailable')
        default:
            return null
    }
}

function lockReason(row: InventoryRow, t: (key: string) => string): string | undefined {
    if (!row.lock) return undefined
    return row.lock === 'unsupported' ? t('session.config.unsupported') : t('session.config.locked')
}

function ConfigSwitch(props: { row: InventoryRow; pending: boolean; onToggle: (enabled: boolean) => void }) {
    const { t } = useTranslation()
    const reason = lockReason(props.row, t)
    const hint = props.row.mutable && props.row.ref.kind === 'skill' ? t('session.config.skillHint') : reason
    return (
        <span className={`inline-flex items-center gap-2 ${props.row.mutable ? '' : 'max-w-56'}`}>
            {hint ? <span className={`text-right text-[11px] leading-4 text-[var(--app-hint)] ${props.row.mutable ? 'whitespace-nowrap' : ''}`}>{hint}</span> : null}
            <button
                type="button"
                role="switch"
                aria-checked={props.row.enabled}
                aria-label={t('session.config.toggle', { name: props.row.title })}
                disabled={!props.row.mutable || props.pending}
                title={hint ?? t('session.config.effect')}
                onClick={(event) => {
                    event.stopPropagation()
                    props.onToggle(!props.row.enabled)
                }}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${props.row.enabled ? 'bg-[var(--app-link)]' : 'bg-[var(--app-border)]'} disabled:cursor-not-allowed disabled:opacity-40`}
            >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-[var(--app-bg)] ${props.row.enabled ? 'left-4' : 'left-0.5'}`} />
            </button>
        </span>
    )
}

function RowText(props: { item: InventoryRow }) {
    const { t } = useTranslation()
    return (
        <>
            <div className="flex min-w-0 items-baseline gap-2">
                <span className="max-w-[45%] shrink-0 truncate text-sm text-[var(--app-fg)]">{promptTitle(props.item.title, t)}</span>
                {props.item.detail ? (
                    <span className="min-w-0 truncate text-xs text-[var(--app-hint)]">{promptPathLabel(props.item.detail, t)}</span>
                ) : null}
            </div>
            {props.item.preview ? (
                <div className="truncate text-xs text-[var(--app-hint)]">{props.item.preview}</div>
            ) : null}
            {props.item.load ? (
                <div className="text-xs text-[var(--app-hint)]">
                    {t(`session.config.prompt.load.${props.item.load}`)}{props.item.match ? ` · ${props.item.match}` : ''}
                </div>
            ) : null}
            {props.item.codexCapped ? (
                <div className="text-xs text-[var(--app-hint)]">{t('session.config.prompt.codexCap')}</div>
            ) : null}
        </>
    )
}

function ConfigSection(props: {
    title: string
    emptyKey: string
    section: InventorySection
    pendingKey: string | null
    onOpen: (row: InventoryRow) => void
    onOpenScript: (row: InventoryRow) => void
    onToggle: (row: InventoryRow, enabled: boolean) => void
}) {
    const { t } = useTranslation()
    const message = sectionMessage(props.section, t, props.emptyKey)
    return (
        <section>
            <h2 className="mb-2 text-base font-semibold text-[var(--app-fg)]">{props.title}</h2>
            <div className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                {message ? (
                    <p className="px-3 py-4 text-sm text-[var(--app-hint)]">{message}</p>
                ) : props.section.status === 'list' ? (
                    <ul>
                        {props.section.rows.map((item) => (
                            <li key={item.key} className={`flex items-center gap-3 border-b border-[var(--app-divider)] px-3 py-2 last:border-b-0 ${item.openable ? 'cursor-pointer hover:bg-[var(--app-subtle-bg)]' : ''}`}>
                                {item.openable ? (
                                    <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => props.onOpen(item)}>
                                        <RowText item={item} />
                                    </button>
                                ) : (
                                    <div className="min-w-0 flex-1 text-left">
                                        <RowText item={item} />
                                    </div>
                                )}
                                {item.scriptPath && item.filePath ? (
                                    <button
                                        type="button"
                                        className="shrink-0 text-xs text-[var(--app-link)]"
                                        onClick={(event) => {
                                            event.stopPropagation()
                                            props.onOpenScript(item)
                                        }}
                                    >
                                        {t('session.config.openScript')}
                                    </button>
                                ) : null}
                                {item.toggle ? (
                                    <ConfigSwitch
                                        row={item}
                                        pending={props.pendingKey === item.key}
                                        onToggle={(enabled) => props.onToggle(item, enabled)}
                                    />
                                ) : null}
                                {item.loaded === undefined ? null : (
                                    <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)]">
                                        {t(item.loaded ? 'session.config.mcp.loaded' : 'session.config.mcp.notLoaded')}
                                    </span>
                                )}
                                {item.source ? (
                                    <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)]">
                                        {t(`session.config.source.${item.source}`)}
                                    </span>
                                ) : null}
                                {item.scopeLabel ? (
                                    <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)]">
                                        {t(`session.config.prompt.scope.${item.scopeLabel}`)}
                                    </span>
                                ) : null}
                                {item.openable ? <span aria-hidden="true" className="shrink-0 text-sm text-[var(--app-hint)]">›</span> : null}
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        </section>
    )
}


export default function SessionConfigPage() {
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/config' })
    const { session } = useSession(api, sessionId)
    const { config, error, isLoading, isFetching, refetch } = useSessionConfig(api, sessionId)
    const [pendingKey, setPendingKey] = useState<string | null>(null)
    const [toggleError, setToggleError] = useState<string | null>(null)

    if (!session || isLoading) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <LoadingState label={t('session.config.loading')} className="text-sm" />
            </div>
        )
    }

    const flavor = session.metadata?.flavor
    const systemPrompt = promptSection(config, 'system')
    const userPrompt = promptSection(config, 'user')
    const mcp = mcpSection(config, flavor)
    const agents = agentsSection(config, flavor)
    const skills = skillsSection(config, flavor)
    const hooks = hooksSection(config, flavor)

    const toggle = async (row: InventoryRow, enabled: boolean) => {
        if (!row.mutable) {
            setToggleError(lockReason(row, t) ?? t('session.config.locked'))
            return
        }
        if (!api) {
            setToggleError(t('session.config.unavailable'))
            return
        }
        setPendingKey(row.key)
        setToggleError(null)
        try {
            const result = await api.setSessionConfigItemEnabled(sessionId, row.ref, enabled)
            if (!result.success) {
                setToggleError(formatSessionConfigError(result.error ?? 'Failed to update session config', t, 'update'))
                return
            }
            await refetch()
        } catch (toggleFailure) {
            setToggleError(formatSessionConfigError(
                toggleFailure instanceof Error ? toggleFailure.message : 'Failed to update session config',
                t,
                'update',
            ))
        } finally {
            setPendingKey(null)
        }
    }

    const openFile = (path: string, line?: number) => {
        void navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId },
            search: { path: encodeBase64(path), origin: 'config', ...(line ? { line } : {}) },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }

    const openRow = (row: InventoryRow) => {
        const path = row.filePath ?? row.scriptPath
        if (!path) return
        openFile(path, row.filePath ? row.line : undefined)
    }

    const openScript = (row: InventoryRow) => {
        if (!row.scriptPath) return
        openFile(row.scriptPath)
    }

    const readError = error != null ? formatSessionConfigError(error, t) : null
    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={session}
                onBack={goBack}
                onToggleFiles={session.metadata?.path ? () => {
                    navigate({
                        to: '/sessions/$sessionId/files',
                        params: { sessionId },
                        ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                    })
                } : undefined}
                filesActive={false}
                onToggleOutline={() => {
                    navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId },
                        search: { outline: true },
                        ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                    })
                }}
                outlineActive={false}
                onToggleConfig={() => {
                    navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId },
                        ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                    })
                }}
                configActive
                api={api}
                titleSuggestionAvailable={titleSuggestionAvailable}
                onSessionDeleted={goBack}
                onSessionReopened={async (newSessionId) => {
                    await transferComposerDraftThenNavigate(
                        session.id,
                        newSessionId,
                        () => navigate({
                            to: '/sessions/$sessionId/config',
                            params: { sessionId: newSessionId },
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
                }}
            />
            <div className="app-scroll-y min-h-0 flex-1">
                {toggleError ? (
                    <SessionReadBanner
                        message={toggleError}
                        onRetry={() => { setToggleError(null); void refetch() }}
                        retrying={isFetching}
                    />
                ) : null}
                {readError !== null ? (
                    <SessionReadBanner
                        message={readError}
                        onRetry={() => { void refetch() }}
                        retrying={isFetching}
                    />
                ) : (
                    <div className="mx-auto flex w-full max-w-content flex-col gap-6 p-4">
                        <ConfigSection title={t('session.config.systemPrompt')} emptyKey="session.config.systemPrompt.empty" section={systemPrompt} pendingKey={pendingKey} onOpen={openRow} onOpenScript={openScript} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <ConfigSection title={t('session.config.userPrompt')} emptyKey="session.config.userPrompt.empty" section={userPrompt} pendingKey={pendingKey} onOpen={openRow} onOpenScript={openScript} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <ConfigSection title={t('session.config.mcp')} emptyKey="session.config.mcp.empty" section={mcp} pendingKey={pendingKey} onOpen={openRow} onOpenScript={openScript} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <ConfigSection title={t('session.config.agents')} emptyKey="session.config.agents.empty" section={agents} pendingKey={pendingKey} onOpen={openRow} onOpenScript={openScript} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <ConfigSection title={t('session.config.skills')} emptyKey="session.config.skills.empty" section={skills} pendingKey={pendingKey} onOpen={openRow} onOpenScript={openScript} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <ConfigSection title={t('session.config.hooks')} emptyKey="session.config.hooks.empty" section={hooks} pendingKey={pendingKey} onOpen={openRow} onOpenScript={openScript} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                    </div>
                )}
            </div>
        </div>
    )
}
