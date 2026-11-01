import { useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import type { SessionInventoryMcpServer, SessionInventorySource } from '@hapi/protocol/schemas'
import { SessionHeader } from '@/components/SessionHeader'
import { SessionReadBanner } from '@/components/SessionReadBanner'
import { LoadingState } from '@/components/LoadingState'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSession } from '@/hooks/queries/useSession'
import { useSessionConfig } from '@/hooks/queries/useSessionConfig'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { useTranslation } from '@/lib/use-translation'
import { formatSessionConfigError } from '@/lib/sessionConfigError'
import { encodeBase64 } from '@/lib/utils'

function statusKey(server: SessionInventoryMcpServer): string {
    if (server.loaded === true) return 'session.config.mcp.loaded'
    if (server.loaded === false) return 'session.config.mcp.notLoaded'
    return 'session.config.mcp.unchecked'
}

export default function SessionConfigServerPage() {
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/config/server' })
    const search = useSearch({ from: '/sessions/$sessionId/config/server' })
    const { session } = useSession(api, sessionId)
    const { config, error, isLoading, isFetching, refetch, reload } = useSessionConfig(api, sessionId)
    const [checking, setChecking] = useState(false)
    const [checkError, setCheckError] = useState<string | null>(null)
    const server = config?.mcp?.servers.find((item) => item.name === search.name && item.source === search.source)
    const readError = error != null ? formatSessionConfigError(error, t) : null

    if (!session || isLoading) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <LoadingState label={t('session.config.loading')} className="text-sm" />
            </div>
        )
    }

    const openFile = () => {
        if (!server?.filePath) return
        void navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId },
            search: {
                path: encodeBase64(server.filePath),
                origin: 'mcp',
                mcpName: server.name,
                mcpSource: server.source,
                ...(server.line ? { line: server.line } : {}),
            },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }

    const check = async () => {
        if (checking || !server) return
        setChecking(true)
        setCheckError(null)
        try {
            await reload({ check: server.name })
        } catch (checkFailure) {
            setCheckError(formatSessionConfigError(
                checkFailure instanceof Error ? checkFailure.message : 'Failed to read session config',
                t,
                'read',
            ))
        } finally {
            setChecking(false)
        }
    }

    const checkable = config?.mcp?.kind === 'servers' && server?.source === 'project'

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={session}
                onBack={goBack}
                configActive
                api={api}
                titleSuggestionAvailable={titleSuggestionAvailable}
                onSessionDeleted={goBack}
                onSessionReopened={async (newSessionId) => {
                    await transferComposerDraftThenNavigate(
                        session.id,
                        newSessionId,
                        () => navigate({
                            to: '/sessions/$sessionId/config/server',
                            params: { sessionId: newSessionId },
                            search,
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
                }}
            />
            <div className="app-scroll-y min-h-0 flex-1">
                {checkError ? (
                    <SessionReadBanner message={checkError} onRetry={() => { void check() }} retrying={checking} />
                ) : null}
                {isLoading ? (
                    <LoadingState />
                ) : readError !== null ? (
                    <SessionReadBanner message={readError} onRetry={() => { void refetch() }} retrying={isFetching} />
                ) : !server ? (
                    <p className="px-4 py-6 text-sm text-[var(--app-hint)]">{t('session.config.unreported')}</p>
                ) : (
                    <div className="mx-auto flex w-full max-w-content flex-col gap-4 p-4 max-sm:pb-24 max-sm:pr-20">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="min-w-0 flex-1 break-words text-lg font-semibold text-[var(--app-fg)]">{server.name}</h1>
                            <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)]">{t(statusKey(server))}</span>
                            <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)]">{t(`session.config.source.${server.source as SessionInventorySource}`)}</span>
                        </div>
                        {server.filePath ? (
                            <button type="button" className="break-all text-left text-sm text-[var(--app-link)]" onClick={openFile}>
                                {server.pathLabel ?? server.filePath}
                            </button>
                        ) : null}
                        {server.tools ? (
                            <p className="text-sm text-[var(--app-fg)]">
                                {t(server.toolsTruncated ? 'session.config.mcp.toolCountPartial' : 'session.config.mcp.toolCount', { n: server.tools.length })}
                            </p>
                        ) : null}
                        {server.toolsTruncated ? (
                            <p className="text-xs text-[var(--app-hint)]">{t('session.config.truncated')}</p>
                        ) : null}
                        {server.tools && server.tools.length > 0 ? (
                            <ul className="overflow-hidden rounded-lg border border-[var(--app-border)]">
                                {server.tools.map((tool, index) => (
                                    <li key={`${tool.name}:${index}`} className="border-b border-[var(--app-divider)] px-3 py-2 last:border-b-0">
                                        <div className="break-words text-sm text-[var(--app-fg)]">{tool.name}</div>
                                        {tool.description ? <div className="break-words text-xs leading-5 text-[var(--app-hint)]">{tool.description}</div> : null}
                                    </li>
                                ))}
                            </ul>
                        ) : server.tools ? (
                            <p className="text-sm text-[var(--app-hint)]">{t('session.config.mcp.noTools')}</p>
                        ) : (
                            <p className="text-sm text-[var(--app-hint)]">{t(checkable ? 'session.config.mcp.toolsAfterCheck' : 'session.config.mcp.toolsUnavailable')}</p>
                        )}
                        {checkable ? (
                            <button
                                type="button"
                                className="inline-flex items-center gap-1.5 self-start text-sm text-[var(--app-link)] disabled:opacity-50"
                                disabled={checking}
                                aria-busy={checking}
                                onClick={() => { void check() }}
                            >
                                {checking ? <Spinner size="sm" label={null} className="text-current" /> : null}
                                {t(server.loaded === undefined ? 'session.config.mcp.check' : 'session.config.mcp.recheckOne')}
                            </button>
                        ) : null}
                    </div>
                )}
            </div>
        </div>
    )
}
