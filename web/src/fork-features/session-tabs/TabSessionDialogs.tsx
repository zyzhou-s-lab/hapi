import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'

export type TabSessionDialogKind = 'rename' | 'archive'

/**
 * Dialogs opened from a tab's menu. They outlive the menu, so the tab bar
 * mounts them. Rename and archive use the same actions as the session list.
 * Work-line classification is omitted: this fork has no work-overview.
 */
export function TabSessionDialog(props: {
    api: ApiClient | null
    kind: TabSessionDialogKind
    session: SessionSummary
    onClose: () => void
}) {
    const { t } = useTranslation()
    const { session } = props
    const { archiveSession, renameSession, isPending } = useSessionActions(props.api, session.id, session.metadata?.flavor ?? null)
    const name = getSessionTitle(session) || t('tabs.untitled')

    if (props.kind === 'rename') {
        return (
            <RenameSessionDialog
                isOpen={true}
                onClose={props.onClose}
                currentName={name}
                onRename={renameSession}
                isPending={isPending}
            />
        )
    }
    return (
        <ConfirmDialog
            isOpen={true}
            onClose={props.onClose}
            title={t('dialog.archive.title')}
            description={t('dialog.archive.description', { name })}
            confirmLabel={t('dialog.archive.confirm')}
            confirmingLabel={t('dialog.archive.confirming')}
            onConfirm={archiveSession}
            isPending={isPending}
            destructive
            centerTitle
        />
    )
}
