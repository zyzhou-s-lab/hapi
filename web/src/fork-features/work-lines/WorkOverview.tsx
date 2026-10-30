import { useSyncExternalStore, type ReactNode } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import type { SessionSummary } from '@/types/api'
import './cards'
import { WorkCardHost } from './WorkCardHost'

type PhonePane = 'sessions' | 'work'
let phonePane: PhonePane = 'sessions'
const phonePaneListeners = new Set<() => void>()

export function usePhoneWorkPane(): PhonePane {
    return useSyncExternalStore(
        (listener) => {
            phonePaneListeners.add(listener)
            return () => phonePaneListeners.delete(listener)
        },
        () => phonePane,
    )
}

export function setPhoneWorkPane(next: PhonePane): void {
    phonePane = next
    for (const listener of phonePaneListeners) listener()
}

export function PhoneWorkToggle(): ReactNode {
    const { t } = useTranslation()
    return (
        <div className="split:hidden flex gap-2 px-3 py-2">
            <button type="button" className="text-sm text-[var(--app-fg)]" onClick={() => setPhoneWorkPane('work')}>{t('work.pane.work')}</button>
            <button type="button" className="text-sm text-[var(--app-fg)]" onClick={() => setPhoneWorkPane('sessions')}>{t('work.pane.sessions')}</button>
        </div>
    )
}

export function WorkOverview(props: { sessions: SessionSummary[] }): ReactNode {
    const { api } = useAppContext()
    const { t } = useTranslation()

    return (
        <div className="flex h-full min-h-0 flex-col">
            <header className="flex items-center justify-between px-4 py-3">
                <h2 className="text-base font-semibold text-[var(--app-fg)]">{t('work.overviewTitle')}</h2>
                <PhoneWorkToggle />
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <WorkCardHost surface="overview" view={{ kind: 'overview' }} sessions={props.sessions} api={api} />
            </div>
        </div>
    )
}
