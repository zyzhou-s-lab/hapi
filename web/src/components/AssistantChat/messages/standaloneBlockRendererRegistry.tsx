import type { ComponentType } from 'react'
import type { TextMessagePart } from '@assistant-ui/react'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { CodexReviewCard } from '@/components/AssistantChat/messages/CodexReviewCard'
import { useOptionalSessionVisibleEntity } from '@/hooks/useSessionEntityStore'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import {
    STANDALONE_BLOCK_SPECS,
    isStandaloneBlockKind,
    type StandaloneBlockKind,
    type StandaloneBlockSpec,
} from '@/lib/assistant-runtime-blocks'

export { isStandaloneBlockKind, type StandaloneBlockKind, type StandaloneBlockSpec }

export type StandaloneRuntimeRenderProps = {
    readonly custom: Partial<HappyChatMessageMetadata> | undefined
    readonly content: readonly { readonly type: string; readonly text?: string }[]
}

export interface StandaloneBlockRegistration<K extends StandaloneBlockKind = StandaloneBlockKind> extends StandaloneBlockSpec<K> {
    readonly StoreRenderer: ComponentType<{ blockId: string }>
    readonly RuntimeRenderer: ComponentType<StandaloneRuntimeRenderProps>
}

function StoreCliOutputRenderer({ blockId }: { blockId: string }) {
    const entity = useOptionalSessionVisibleEntity(blockId)
    return entity?.kind === 'cli-output' ? <CliOutputBlock text={entity.text} /> : null
}

function RuntimeCliOutputRenderer({ content }: StandaloneRuntimeRenderProps) {
    const cliText = content.find((part): part is TextMessagePart => part.type === 'text')?.text ?? ''
    return <CliOutputBlock text={cliText} />
}

function StoreCodexReviewRenderer({ blockId }: { blockId: string }) {
    const entity = useOptionalSessionVisibleEntity(blockId)
    return entity?.kind === 'codex-review' ? <CodexReviewCard review={entity.review} /> : null
}

function RuntimeCodexReviewRenderer({ custom }: StandaloneRuntimeRenderProps) {
    return custom?.review ? <CodexReviewCard review={custom.review} /> : null
}

export const STANDALONE_BLOCK_RENDERER_REGISTRY: {
    readonly [K in StandaloneBlockKind]: StandaloneBlockRegistration<K>
} = {
    'cli-output': {
        ...STANDALONE_BLOCK_SPECS['cli-output'],
        StoreRenderer: StoreCliOutputRenderer,
        RuntimeRenderer: RuntimeCliOutputRenderer,
    },
    'codex-review': {
        ...STANDALONE_BLOCK_SPECS['codex-review'],
        StoreRenderer: StoreCodexReviewRenderer,
        RuntimeRenderer: RuntimeCodexReviewRenderer,
    },
}

export function getStandaloneBlockRegistration<K extends StandaloneBlockKind>(
    kind: K
): StandaloneBlockRegistration<K>
export function getStandaloneBlockRegistration(
    kind: string | undefined
): StandaloneBlockRegistration<StandaloneBlockKind> | undefined
export function getStandaloneBlockRegistration(
    kind: string | undefined
): StandaloneBlockRegistration<StandaloneBlockKind> | undefined {
    return isStandaloneBlockKind(kind)
        ? STANDALONE_BLOCK_RENDERER_REGISTRY[kind] as StandaloneBlockRegistration<StandaloneBlockKind>
        : undefined
}
