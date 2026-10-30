import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

export function SessionReadBanner(props: {
    message: string
    onRetry?: () => void
    retrying?: boolean
}) {
    const { t } = useTranslation()
    return (
        <div className="border-b border-[var(--app-divider)] bg-amber-500/10 px-3 py-2 text-xs text-[var(--app-hint)]" role="alert">
            {props.onRetry ? (
                <div className="mx-auto flex w-full max-w-content items-center gap-3">
                    <p className="min-w-0 flex-1">{props.message}</p>
                    <Button
                        variant="outline"
                        type="button"
                        onClick={props.onRetry}
                        disabled={props.retrying}
                        aria-busy={props.retrying || undefined}
                        className="h-7 shrink-0 px-2 text-xs"
                    >
                        {t('button.retry')}
                    </Button>
                </div>
            ) : props.message}
        </div>
    )
}
