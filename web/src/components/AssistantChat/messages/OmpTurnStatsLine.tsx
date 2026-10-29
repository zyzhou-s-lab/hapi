import type { OmpTurnFooter } from '@/chat/ompTurnFooter'
import { formatOmpTurnFooter } from '@/chat/ompTurnFooter'

export function OmpTurnStatsLine(props: { footer: OmpTurnFooter }) {
    const text = formatOmpTurnFooter(props.footer)
    if (!text) return null
    return (
        <p
            data-testid="omp-turn-stats"
            className="mt-1 px-1 text-xs leading-snug text-[var(--app-hint)]"
        >
            {text}
        </p>
    )
}
