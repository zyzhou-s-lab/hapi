import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { FileMarkdownView } from '@/components/FileMarkdownView'
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
import { queryKeys } from '@/lib/query-keys'
import {
    hooksSection,
    mcpSection,
    promptSection,
    skillsSection,
    type InventoryRow,
    type InventorySection,
} from '@/lib/sessionInventoryView'
import type { SessionConfigDetailResult } from '@hapi/protocol/schemas'

function promptCopy(code: string | undefined, t: (key: string) => string): string | null {
    if (!code) return null
    const key = code.startsWith('session.config.') ? code : `session.config.prompt.note.${code}`
    const translated = t(key)
    return translated === key ? code : translated
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

function sectionMessage(section: InventorySection, t: (key: string) => string): string | null {
    switch (section.status) {
        case 'unreported':
            return t('session.config.unreported')
        case 'empty':
            return t('session.config.empty')
        case 'none':
            return section.note ? promptCopy(section.note, t) : t('session.config.hooks.none')
        case 'catalogUnavailable':
            return t('session.config.skills.catalogUnavailable')
        default:
            return null
    }
}

function ConfigSwitch(props: { row: InventoryRow; pending: boolean; onToggle: (enabled: boolean) => void }) {
    const { t } = useTranslation()
    return (
        <button
            type="button"
            role="switch"
            aria-checked={props.row.enabled}
            aria-label={t('session.config.toggle', { name: props.row.title })}
            disabled={!props.row.mutable || props.pending}
            title={props.row.lock === 'unsupported' ? t('session.config.unsupported') : props.row.mutable ? t('session.config.effect') : t('session.config.locked')}
            onClick={(event) => {
                event.stopPropagation()
                props.onToggle(!props.row.enabled)
            }}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${props.row.enabled ? 'bg-[var(--app-link)]' : 'bg-[var(--app-border)]'} disabled:opacity-40`}
        >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-[var(--app-bg)] ${props.row.enabled ? 'left-4' : 'left-0.5'}`} />
        </button>
    )
}

function ConfigSection(props: {
    title: string
    section: InventorySection
    toolsHint?: string
    pendingKey: string | null
    onOpen: (row: InventoryRow) => void
    onToggle: (row: InventoryRow, enabled: boolean) => void
}) {
    const { t } = useTranslation()
    const message = sectionMessage(props.section, t)
    return (
        <section>
            <h2 className="mb-2 text-base font-semibold text-[var(--app-fg)]">{props.title}</h2>
            {props.section.status === 'list' && props.section.note ? (
                <p className="mb-2 text-xs text-[var(--app-hint)]">{promptCopy(props.section.note, t)}</p>
            ) : null}
            {props.section.status === 'list' && props.section.tools ? (
                <p className="mb-2 text-xs text-[var(--app-hint)]">{props.toolsHint}</p>
            ) : null}
            <div className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                {message ? (
                    <p className="px-3 py-4 text-sm text-[var(--app-hint)]">{message}</p>
                ) : props.section.status === 'list' ? (
                    <ul>
                        {props.section.rows.map((item) => (
                            <li key={item.key} className="flex items-center gap-3 border-b border-[var(--app-divider)] px-3 py-2 last:border-b-0">
                                {item.openable ? (
                                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => props.onOpen(item)}>
                                        <div className="truncate text-sm text-[var(--app-fg)]">{promptTitle(item.title, t)}</div>
                                        {item.detail ? (
                                            <div className="truncate text-xs text-[var(--app-hint)]">{item.detail}</div>
                                        ) : null}
                                        {item.preview ? (
                                            <div className="truncate text-xs text-[var(--app-hint)]">{item.preview}</div>
                                        ) : null}
                                        {item.load ? (
                                            <div className="text-xs text-[var(--app-hint)]">
                                                {t(`session.config.prompt.load.${item.load}`)}{item.match ? ` · ${item.match}` : ''}
                                            </div>
                                        ) : null}
                                        {item.note ? (
                                            <div className="text-xs text-[var(--app-hint)]">{promptCopy(item.note, t)}</div>
                                        ) : null}
                                        {item.codexCapped ? (
                                            <div className="text-xs text-[var(--app-hint)]">{t('session.config.prompt.codexCap')}</div>
                                        ) : null}
                                        {item.lock ? (
                                            <div className="text-xs text-[var(--app-hint)]">
                                                {item.lock === 'unsupported' ? t('session.config.unsupported') : t('session.config.locked')}
                                            </div>
                                        ) : null}
                                    </button>
                                ) : (
                                    <div className="min-w-0 flex-1 text-left">
                                        <div className="truncate text-sm text-[var(--app-fg)]">{promptTitle(item.title, t)}</div>
                                        {item.note ? (
                                            <div className="text-xs text-[var(--app-hint)]">{promptCopy(item.note, t)}</div>
                                        ) : null}
                                    </div>
                                )}
                                {item.toggle ? (
                                    <ConfigSwitch
                                        row={item}
                                        pending={props.pendingKey === item.key}
                                        onToggle={(enabled) => props.onToggle(item, enabled)}
                                    />
                                ) : null}
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
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        </section>
    )
}

function ConfigDetail(props: { detail: Extract<SessionConfigDetailResult, { success: true }> }) {
    const { t } = useTranslation()
    const detail = props.detail
    return (
        <div className="flex flex-col gap-4">
            {detail.kind === 'skill' || detail.kind === 'prompt' ? (
                <>
                    {detail.kind === 'prompt' && detail.note ? <p className="text-xs text-[var(--app-hint)]">{promptCopy(detail.note, t)}</p> : null}
                    {detail.kind === 'prompt' && detail.codexCapped ? <p className="text-xs text-[var(--app-hint)]">{t('session.config.prompt.codexCap')}</p> : null}
                    {detail.truncated ? <p className="text-xs text-[var(--app-hint)]">{t('session.config.truncated')}</p> : null}
                    <FileMarkdownView content={detail.kind === 'skill' ? detail.markdown : detail.markdown} />
                </>
            ) : null}
            {detail.kind === 'mcp' ? (
                detail.tools.length === 0 ? (
                    <p className="text-sm text-[var(--app-hint)]">{detail.toolsUnavailable ? t('session.config.mcp.toolsUnavailable') : t('session.config.empty')}</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {detail.tools.map((tool) => (
                            <li key={tool.name}>
                                <div className="text-sm text-[var(--app-fg)]">{tool.name}</div>
                                {tool.description ? <div className="text-xs text-[var(--app-hint)]">{tool.description}</div> : null}
                            </li>
                        ))}
                    </ul>
                )
            ) : null}
            {detail.kind === 'hook' ? (
                <>
                    <p className="text-sm text-[var(--app-fg)]">{detail.event}{detail.matcher ? ` · ${detail.matcher}` : ''}</p>
                    {detail.truncated ? <p className="text-xs text-[var(--app-hint)]">{t('session.config.truncated')}</p> : null}
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-[var(--app-fg)]">{detail.script}</pre>
                </>
            ) : null}
        </div>
    )
}

export default function SessionConfigPage() {
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/config' })
    const { session } = useSession(api, sessionId)
    const { config, error, isLoading, isFetching, refetch } = useSessionConfig(api, sessionId)
    const [selected, setSelected] = useState<InventoryRow | null>(null)
    const [pendingKey, setPendingKey] = useState<string | null>(null)
    const [toggleError, setToggleError] = useState<string | null>(null)
    const detailQuery = useQuery({
        queryKey: queryKeys.sessionConfigItem(sessionId, selected?.key ?? ''),
        enabled: Boolean(api && selected),
        queryFn: async () => {
            if (!api || !selected) throw new Error('Session unavailable')
            const response = await api.getSessionConfigItem(sessionId, selected.ref)
            if (!response.success) return { detail: null, error: response.error ?? 'Session config unavailable' }
            return { detail: response, error: null }
        },
    })

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
    const skills = skillsSection(config, flavor)
    const hooks = hooksSection(config, flavor)
    const detailError = detailQuery.error instanceof Error
        ? detailQuery.error.message
        : detailQuery.data?.error ?? null
    const detail = detailQuery.data?.detail ?? null

    const toggle = async (row: InventoryRow, enabled: boolean) => {
        if (!api || !row.mutable) return
        setPendingKey(row.key)
        setToggleError(null)
        try {
            const result = await api.setSessionConfigItemEnabled(sessionId, row.ref, enabled)
            if (!result.success) {
                setToggleError(result.error ?? 'Failed to update session config')
                return
            }
            await refetch()
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessionConfigItem(sessionId, row.key) })
        } catch (toggleFailure) {
            setToggleError(toggleFailure instanceof Error ? toggleFailure.message : 'Failed to update session config')
        } finally {
            setPendingKey(null)
        }
    }

    const pageError = error ?? toggleError
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
                {pageError !== null ? (
                    <SessionReadBanner
                        message={formatSessionConfigError(pageError, t)}
                        onRetry={() => { void refetch() }}
                        retrying={isFetching}
                    />
                ) : selected ? (
                    <div className="mx-auto flex w-full max-w-content flex-col gap-4 p-4">
                        <button type="button" className="self-start text-sm text-[var(--app-link)]" onClick={() => setSelected(null)}>
                            {t('session.config.backToList')}
                        </button>
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="min-w-0 truncate text-base font-semibold text-[var(--app-fg)]">{promptTitle(selected.title, t)}</h2>
                            {selected.toggle ? (
                                <ConfigSwitch row={selected} pending={pendingKey === selected.key} onToggle={(enabled) => { void toggle(selected, enabled) }} />
                            ) : null}
                        </div>
                        {selected.lock ? (
                            <p className="text-sm text-[var(--app-hint)]">
                                {selected.lock === 'unsupported' ? t('session.config.unsupported') : t('session.config.locked')}
                            </p>
                        ) : selected.toggle ? (
                            <p className="text-xs text-[var(--app-hint)]">{t('session.config.effect')}</p>
                        ) : null}
                        {detailError ? (
                            <SessionReadBanner
                                message={formatSessionConfigError(detailError, t)}
                                onRetry={() => { void detailQuery.refetch() }}
                                retrying={detailQuery.isFetching}
                            />
                        ) : detailQuery.isLoading || !detail ? (
                            <LoadingState label={t('session.config.loading')} className="text-sm" />
                        ) : (
                            <ConfigDetail detail={detail} />
                        )}
                    </div>
                ) : (
                    <div className="mx-auto flex w-full max-w-content flex-col gap-6 p-4">
                        <ConfigSection title={t('session.config.systemPrompt')} section={systemPrompt} pendingKey={pendingKey} onOpen={setSelected} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <ConfigSection title={t('session.config.userPrompt')} section={userPrompt} pendingKey={pendingKey} onOpen={setSelected} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <p className="text-xs text-[var(--app-hint)]">{t('session.config.effect')}</p>
                        <ConfigSection title={t('session.config.mcp')} section={mcp} toolsHint={t('session.config.mcp.toolsHint')} pendingKey={pendingKey} onOpen={setSelected} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <ConfigSection title={t('session.config.skills')} section={skills} pendingKey={pendingKey} onOpen={setSelected} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                        <ConfigSection title={t('session.config.hooks')} section={hooks} pendingKey={pendingKey} onOpen={setSelected} onToggle={(row, enabled) => { void toggle(row, enabled) }} />
                    </div>
                )}
            </div>
        </div>
    )
}
