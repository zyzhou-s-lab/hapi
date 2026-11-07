import type { ChatBlock, UserTextBlock } from '@/chat/types'

export type ConversationOutlineItem = {
    id: string
    targetMessageId: string
    kind: 'user'
    label: string
    createdAt: number
}

const MAX_OUTLINE_LABEL_LENGTH = 96

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

export function truncateOutlineLabel(value: string, maxLength = MAX_OUTLINE_LABEL_LENGTH): string {
    const normalized = collapseWhitespace(value)
    if (normalized.length <= maxLength) {
        return normalized
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function userBlockToOutlineItem(block: UserTextBlock, seen: Map<string, number>): ConversationOutlineItem {
    const label = truncateOutlineLabel(block.text) || 'Empty message'
    const base = `user-text:${block.localId || block.id}`
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    const messageId = occurrence === 0 ? base : `${base}~${occurrence}`
    return {
        id: `outline:${messageId}`,
        targetMessageId: messageId,
        kind: 'user',
        label,
        createdAt: block.createdAt
    }
}

function isLocatableOutlineBlock(block: ChatBlock): block is UserTextBlock {
    return block.kind === 'user-text'
        && !(block.invokedAt === null && block.status !== 'failed')
}

export function buildConversationOutline(blocks: readonly ChatBlock[]): ConversationOutlineItem[] {
    const items: ConversationOutlineItem[] = []
    const seen = new Map<string, number>()

    for (const block of blocks) {
        if (isLocatableOutlineBlock(block)) {
            items.push(userBlockToOutlineItem(block, seen))
        }
    }

    return items
}

export function getConversationMessageAnchorId(messageId: string): string {
    return `hapi-message-${messageId}`
}
