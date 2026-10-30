import { useNavigate, useParams } from '@tanstack/react-router'
import { SessionHeader } from '@/components/SessionHeader'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSession } from '@/hooks/queries/useSession'
import { useSessionConfig } from '@/hooks/queries/useSessionConfig'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { useTranslation } from '@/lib/use-translation'
import {
    hooksSection,
    mcpSection,
    skillsSection,
    type InventorySection,
} from '@/lib/sessionInventoryView'

function sectionMessage(section: InventorySection, t: (key: string) => string): string | null {
    switch (section.status) {
        case 'unreported':
            return t('session.config.unreported')
        case 'empty':
            return t('session.config.empty')
        case 'none':
            return t('session.config.hooks.none')
        case 'catalogUnavailable':
            return t('session.config.skills.catalogUnavailable')
        case 'list':
            return null
    }
}

function ConfigSection(props: {
    title: string
    section: InventorySection
    toolsHint?: string
}) {
    const { t } = useTranslation()
    const message = sectionMessage(props.section, t)
    return (
        <section>
            <h2 className="mb-2 text-base font-semibold text-[var(--app-fg)]">{props.title}</h2>
            {props.section.status === 'list' && props.section.tools ? (
                <p className="mb-2 text-xs text-[var(--app-hint)]">{props.toolsHint}</p>
            ) : null}
            <div className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                {message ? (
                    <p className="px-3 py-4 text-sm text-[var(--app-hint)]">{message}</p>
                ) : props.section.status === 'list' ? (
                    <ul>
                        {props.section.rows.map((item) => (
                            <li key={item.key} className="flex items-start justify-between gap-3 border-b border-[var(--app-divider)] px-3 py-2 last:border-b-0">
                                <div className="min-w-0">
                                    <div className="truncate text-sm text-[var(--app-fg)]">{item.title}</div>
                                    {item.detail ? (
                                        <div className="truncate text-xs text-[var(--app-hint)]">{item.detail}</div>
                                    ) : null}
                                </div>
                                {item.source ? (
                                    <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)]">
                                        {t(`session.config.source.${item.source}`)}
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

export default function SessionConfigPage() {
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/config' })
    const { session } = useSession(api, sessionId)
    const { config, error, isLoading } = useSessionConfig(api, sessionId)

    if (!session || isLoading) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <LoadingState label={t('session.config.loading')} className="text-sm" />
            </div>
        )
    }

    const inventory = config
    const mcp = mcpSection(inventory)
    const skills = skillsSection(inventory)
    const hooks = hooksSection(inventory)

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
                <div className="mx-auto flex w-full max-w-content flex-col gap-6 p-4">
                    {error ? (
                        <p className="text-sm text-[var(--app-hint)]">{t('session.config.unavailable')}</p>
                    ) : (
                        <>
                            <ConfigSection title={t('session.config.mcp')} section={mcp} toolsHint={t('session.config.mcp.toolsHint')} />
                            <ConfigSection title={t('session.config.skills')} section={skills} />
                            <ConfigSection title={t('session.config.hooks')} section={hooks} />
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
