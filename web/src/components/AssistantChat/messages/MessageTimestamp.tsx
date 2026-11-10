import { useAuiState } from '@assistant-ui/react'
import { formatMessageTimestamp, formatMessageTimestampTitle } from '@/chat/presentation'
import { cn } from '@/lib/utils'

type MessageTimestampProps = {
    className?: string
    createdAt?: Date | number
}

function MessageTimestampView(props: { className?: string; createdAt: Date }) {
    return (
        <time
            dateTime={props.createdAt.toISOString()}
            title={formatMessageTimestampTitle(props.createdAt)}
            className={cn('tabular-nums', props.className)}
        >
            {formatMessageTimestamp(props.createdAt)}
        </time>
    )
}

function AuiMessageTimestamp(props: { className?: string }) {
    const createdAt = useAuiState((s) => s.message.createdAt)
    return <MessageTimestampView className={props.className} createdAt={createdAt} />
}

export function MessageTimestamp(props: MessageTimestampProps) {
    if (props.createdAt !== undefined) {
        const date = props.createdAt instanceof Date ? props.createdAt : new Date(props.createdAt)
        return <MessageTimestampView className={props.className} createdAt={date} />
    }
    return <AuiMessageTimestamp className={props.className} />
}
