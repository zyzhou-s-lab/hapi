import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { Link } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import './cards'
import { WorkCardHost } from './WorkCardHost'

type PhonePane = 'sessions' | 'work'

const PhonePaneContext = createContext<{
    pane: PhonePane
    setPane: (pane: PhonePane) => void
} | null>(null)

export function PhoneWorkPaneProvider(props: { children: ReactNode }): ReactNode {
    const [pane, setPane] = useState<PhonePane>('sessions')
    const value = useMemo(() => ({ pane, setPane }), [pane])
    return <PhonePaneContext.Provider value={value}>{props.children}</PhonePaneContext.Provider>
}

export function usePhoneWorkPane(): PhonePane {
    return useContext(PhonePaneContext)?.pane ?? 'sessions'
}

export function PhoneWorkToggle(): ReactNode {
    const context = useContext(PhonePaneContext)
    const { t } = useTranslation()
    const pane = context?.pane ?? 'sessions'
    const selected = 'text-sm font-semibold text-[var(--app-fg)]'
    const idle = 'text-sm text-[var(--app-hint)]'
    return (
        <div className="split:hidden flex gap-2 px-3 py-2">
            <button type="button" aria-pressed={pane === 'work'} className={pane === 'work' ? selected : idle} onClick={() => context?.setPane('work')}>{t('work.pane.work')}</button>
            <button type="button" aria-pressed={pane === 'sessions'} className={pane === 'sessions' ? selected : idle} onClick={() => context?.setPane('sessions')}>{t('work.pane.sessions')}</button>
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
                <div className="flex items-center gap-3">
                    <Link to="/work" className="text-sm text-[var(--app-link)]">{t('work.openWorkbench')}</Link>
                    <PhoneWorkToggle />
                </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <WorkCardHost surface="overview" view={{ kind: 'overview' }} sessions={props.sessions} api={api} />
            </div>
        </div>
    )
}
