import { describe, expect, it, vi } from 'vitest'
import { createSessionEntityStore } from './sessionEntityStore'
import { normalizeDecryptedMessage } from '../normalize'
import { reduceChatBlocks } from '../reducer'
import { buildVisibleChatBlocks } from '../toolGroups'
import {
    partitionTurn,
    projectTurn,
    type TurnContentPart,
} from '@/components/AssistantChat/messages/turnBlockModel'
import type { AgentState, DecryptedMessage } from '@/types/api'

function makeUserMessage(id: string, text: string, seq: number, createdAt = seq * 1000): DecryptedMessage {
    return {
        id,
        seq,
        localId: id,
        createdAt,
        invokedAt: createdAt,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text,
            },
        },
    }
}

function makeAssistantTextMessage(
    id: string,
    text: string,
    seq: number,
    options?: { live?: boolean; createdAt?: number }
): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt: options?.createdAt ?? seq * 1000,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    id,
                    message: text,
                    streamSnapshot: true,
                    ...(options?.live ? { live: true } : {}),
                },
            },
        },
    }
}

function makeClaudeToolUseMessage(
    id: string,
    uuid: string,
    toolId: string,
    toolName: string,
    input: Record<string, unknown>,
    seq: number
): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt: seq * 1000,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid,
                    message: {
                        role: 'assistant',
                        model: 'claude-sonnet-4-5',
                        content: [
                            {
                                type: 'tool_use',
                                id: toolId,
                                name: toolName,
                                input,
                            },
                        ],
                    },
                },
            },
        },
    }
}

function makeClaudeToolResultMessage(
    id: string,
    uuid: string,
    toolId: string,
    output: string,
    seq: number,
    isError = false
): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt: seq * 1000,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid,
                    message: {
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: toolId,
                                content: output,
                                is_error: isError,
                            },
                        ],
                    },
                },
            },
        },
    }
}

describe('SessionEntityStore', () => {
    it('produces identical blocks to full reduction while reusing settled prefix during active-tail streaming', () => {
        const store = createSessionEntityStore()
        const baseMessages: DecryptedMessage[] = [
            makeUserMessage('u1', 'Read package.json', 1),
            makeClaudeToolUseMessage('a1-use', 'uuid-a1-use', 'tool-1', 'Read', { file_path: 'package.json' }, 2),
            makeClaudeToolResultMessage('a1-res', 'uuid-a1-res', 'tool-1', '{"name":"hapi"}', 3),
            makeAssistantTextMessage('a1-txt', 'I read package.json.', 4),
            makeUserMessage('u2', 'Explain the scripts section', 5),
            makeAssistantTextMessage('a2-txt', 'The scripts section', 6, { live: true }),
        ]

        const snap1 = store.reconcileInput({
            sessionId: 'sess-1',
            messages: baseMessages,
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })

        // Stream 3 deltas in Turn 2
        const deltas = [
            'The scripts section defines dev and build.',
            'The scripts section defines dev, build, and test.',
            'The scripts section defines dev, build, test, and typecheck.',
        ]

        let lastSnap = snap1
        for (const text of deltas) {
            const nextMessages = [
                ...baseMessages.slice(0, 5),
                makeAssistantTextMessage('a2-txt', text, 6, { live: true }),
            ]
            lastSnap = store.reconcileInput({
                sessionId: 'sess-1',
                messages: nextMessages,
                agentState: null,
                hasMoreMessages: false,
                codexExplorationCollapsed: false,
            })

            const fullNormalized = nextMessages
                .map((m) => normalizeDecryptedMessage(m))
                .filter((m): m is NonNullable<typeof m> => m !== null)
            const fullReduced = reduceChatBlocks(fullNormalized, null)
            const fullVisible = buildVisibleChatBlocks(fullReduced.blocks, {
                hasMoreMessages: false,
                codexExplorationCollapsed: false,
            })

            expect(lastSnap.blocks.map((b) => ({ kind: b.kind, id: b.id }))).toEqual(
                fullReduced.blocks.map((b) => ({ kind: b.kind, id: b.id }))
            )
            expect(lastSnap.visibleBlocks.length).toBe(fullVisible.length)
            const lastBlock = lastSnap.blocks[lastSnap.blocks.length - 1]
            expect(lastBlock?.kind === 'agent-text' && lastBlock.text).toBe(text)
        }

        // Turn 1 blocks and timelineIndex reference must be 100% preserved across all Turn 2 deltas
        expect(lastSnap.timelineIndex).toBe(snap1.timelineIndex)
        expect(lastSnap.blocks[0]).toBe(snap1.blocks[0])
        expect(lastSnap.blocks[1]).toBe(snap1.blocks[1])
        expect(lastSnap.blocks[2]).toBe(snap1.blocks[2])
    })

    it('notifies only the mutated entity listener during streaming deltas and keeps timeline subscribers quiet', () => {
        const store = createSessionEntityStore()
        const messages1: DecryptedMessage[] = [
            makeUserMessage('u1', 'First question', 1),
            makeAssistantTextMessage('a1', 'First answer', 2),
            makeUserMessage('u2', 'Second question', 3),
            makeAssistantTextMessage('a2', 'Streaming part 1', 4, { live: true }),
        ]

        const initial = store.reconcileInput({
            sessionId: 'sess-1',
            messages: messages1,
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })

        const timelineListener = vi.fn()
        const turn1EntityListener = vi.fn()
        const turn2EntityListener = vi.fn()

        const unsubTimeline = store.subscribeTimeline(timelineListener)
        const unsubTurn1 = store.subscribeEntity('a1:0', turn1EntityListener)
        const unsubTurn2 = store.subscribeEntity('a2:0', turn2EntityListener)

        const messages2: DecryptedMessage[] = [
            ...messages1.slice(0, 3),
            makeAssistantTextMessage('a2', 'Streaming part 1 + part 2', 4, { live: true }),
        ]
        const next = store.reconcileInput({
            sessionId: 'sess-1',
            messages: messages2,
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })

        expect(next.timelineIndex).toBe(initial.timelineIndex)
        expect(timelineListener).not.toHaveBeenCalled()
        expect(turn1EntityListener).not.toHaveBeenCalled()
        expect(turn2EntityListener).toHaveBeenCalledTimes(1)

        unsubTimeline()
        unsubTurn1()
        unsubTurn2()
    })

    it('invalidates the settled prefix when a late tool result or permission targets a prefix tool call', () => {
        const store = createSessionEntityStore()
        const messagesWithRunningPrefixTool: DecryptedMessage[] = [
            makeUserMessage('u1', 'Run command', 1),
            makeClaudeToolUseMessage('a1-use', 'uuid-a1-use', 'tool-bg', 'Task', { description: 'bg check' }, 2),
            makeUserMessage('u2', 'Next turn', 3),
            makeAssistantTextMessage('a2', 'Working on next turn', 4, { live: true }),
        ]

        const snap1 = store.reconcileInput({
            sessionId: 'sess-1',
            messages: messagesWithRunningPrefixTool,
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })
        expect(snap1.blocks[1]?.kind === 'tool-call' && snap1.blocks[1].tool.state).toBe('running')

        // Now tool-bg finishes in the tail
        const messagesAfterLateResult: DecryptedMessage[] = [
            ...messagesWithRunningPrefixTool,
            makeClaudeToolResultMessage('a1-res', 'uuid-a1-res', 'tool-bg', 'done', 5),
        ]
        const snap2 = store.reconcileInput({
            sessionId: 'sess-1',
            messages: messagesAfterLateResult,
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })

        expect(snap2.blocks[1]?.kind === 'tool-call' && snap2.blocks[1].tool.state).toBe('completed')
        expect(snap2.blocks[1]?.kind === 'tool-call' && snap2.blocks[1].tool.result).toBe('done')

        // Also test agentState.completedRequests updating a settled tool call
        const messagesWithCompletedTurn1: DecryptedMessage[] = [
            makeUserMessage('u1', 'Run command', 1),
            makeClaudeToolUseMessage('a1-use', 'uuid-a1-use', 'tool-perm', 'Bash', { command: 'ls' }, 2),
            makeClaudeToolResultMessage('a1-res', 'uuid-a1-res', 'tool-perm', 'file.txt', 3),
            makeUserMessage('u2', 'Second turn', 4),
            makeAssistantTextMessage('a2', 'Hello', 5),
        ]
        store.reconcileInput({
            sessionId: 'sess-2',
            messages: messagesWithCompletedTurn1,
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })

        const agentStateWithPerm: AgentState = {
            CompletedRequests: undefined,
            completedRequests: {
                'tool-perm': {
                    tool: 'Bash',
                    arguments: { command: 'ls' },
                    createdAt: 1500,
                    completedAt: 2500,
                    status: 'approved',
                },
            },
        } as unknown as AgentState

        const snapPerm = store.reconcileInput({
            sessionId: 'sess-2',
            messages: messagesWithCompletedTurn1,
            agentState: agentStateWithPerm,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })
        expect(snapPerm.blocks[1]?.kind === 'tool-call' && snapPerm.blocks[1].tool.permission?.status).toBe('approved')
    })

    it('handles pagination prepend and session switches cleanly', () => {
        const store = createSessionEntityStore()
        const tailMessages: DecryptedMessage[] = [
            makeUserMessage('u2', 'Turn 2', 10),
            makeAssistantTextMessage('a2', 'Answer 2', 11),
            makeUserMessage('u3', 'Turn 3', 12),
            makeAssistantTextMessage('a3', 'Answer 3', 13),
        ]

        const snapTail = store.reconcileInput({
            sessionId: 'sess-1',
            messages: tailMessages,
            agentState: null,
            hasMoreMessages: true,
            codexExplorationCollapsed: false,
        })
        expect(snapTail.timelineIndex.map((e) => e.id)).toEqual(['u2', 'a2:0', 'u3', 'a3:0'])

        // Prepend older turn u1/a1
        const prependedMessages: DecryptedMessage[] = [
            makeUserMessage('u1', 'Turn 1', 1),
            makeAssistantTextMessage('a1', 'Answer 1', 2),
            ...tailMessages,
        ]
        const snapPrepended = store.reconcileInput({
            sessionId: 'sess-1',
            messages: prependedMessages,
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })
        expect(snapPrepended.timelineIndex.map((e) => e.id)).toEqual(['u1', 'a1:0', 'u2', 'a2:0', 'u3', 'a3:0'])
        // Reconciled blocks from u2..a3 preserve object identity
        expect(snapPrepended.blocks[2]).toBe(snapTail.blocks[0])
        expect(snapPrepended.blocks[3]).toBe(snapTail.blocks[1])

        // Switch session
        const snapOtherSession = store.reconcileInput({
            sessionId: 'sess-other',
            messages: [makeUserMessage('u-other', 'Other session', 1)],
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })
        expect(snapOtherSession.sessionId).toBe('sess-other')
        expect(snapOtherSession.timelineIndex.map((e) => e.id)).toEqual(['u-other'])
    })

    it('propagates Codex turnId, phase: commentary -> execution, and live streaming flag across streamId snapshots', () => {
        const store = createSessionEntityStore()
        const codexLiveMsg: DecryptedMessage = {
            id: 'codex-msg-1',
            seq: 1,
            localId: null,
            createdAt: 1000,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        id: 'stream-item-1',
                        turn_id: 'turn-abc',
                        phase: 'commentary',
                        streamSnapshot: true,
                        live: true,
                        message: 'Checking workspace files...',
                    },
                },
            },
        }

        const liveSnap = store.reconcileInput({
            sessionId: 'sess-codex',
            messages: [codexLiveMsg],
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })
        expect(liveSnap.hasLiveStreamingMessage).toBe(true)
        expect(liveSnap.blocks).toHaveLength(1)
        const liveBlock = liveSnap.blocks[0]!
        expect(liveBlock.kind).toBe('agent-text')
        if (liveBlock.kind === 'agent-text') {
            expect(liveBlock.phase).toBe('execution')
            expect(liveBlock.turnId).toBe('turn-abc')
            expect(liveBlock.text).toBe('Checking workspace files...')
        }

        const codexSettledMsg: DecryptedMessage = {
            ...codexLiveMsg,
            id: 'codex-msg-2',
            seq: 2,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        id: 'stream-item-1',
                        turn_id: 'turn-abc',
                        phase: 'commentary',
                        streamSnapshot: true,
                        message: 'Checking workspace files completed.',
                    },
                },
            },
        }

        const settledSnap = store.reconcileInput({
            sessionId: 'sess-codex',
            messages: [codexSettledMsg],
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })
        expect(settledSnap.hasLiveStreamingMessage).toBe(false)
        expect(settledSnap.blocks).toHaveLength(1)
        const settledBlock = settledSnap.blocks[0]!
        expect(settledBlock.kind).toBe('agent-text')
        if (settledBlock.kind === 'agent-text') {
            expect(settledBlock.phase).toBe('execution')
            expect(settledBlock.turnId).toBe('turn-abc')
            expect(settledBlock.text).toBe('Checking workspace files completed.')
        }
    })
})

describe('partitionTurn and projectTurn reference stabilization', () => {
    it('preserves stepRows and nonTrailingRows references when trailing answer text streams', () => {
        const readBlock = {
            kind: 'tool-call' as const,
            id: 'tool-read-1',
            localId: null,
            createdAt: 1000,
            children: [],
            tool: {
                id: 'tool-read-1',
                name: 'Read',
                state: 'completed' as const,
                input: { file_path: 'src/index.ts' },
                createdAt: 1000,
                completedAt: 1100,
                result: 'export const x = 1\n',
            },
        }

        const parts1: TurnContentPart[] = [
            { type: 'reasoning', text: 'Inspecting entry file' },
            { type: 'tool-call', toolCallId: 'tool-read-1', toolName: 'Read', artifact: readBlock },
            { type: 'text', text: 'Here is the first', status: { type: 'running' } },
        ]
        const partition1 = partitionTurn(parts1, null, null)
        const projected1 = projectTurn(partition1, { viewMode: 'normal', streaming: true }, null)

        const parts2: TurnContentPart[] = [
            { type: 'reasoning', text: 'Inspecting entry file' },
            { type: 'tool-call', toolCallId: 'tool-read-1', toolName: 'Read', artifact: readBlock },
            { type: 'text', text: 'Here is the first paragraph with more tokens.', status: { type: 'running' } },
        ]
        const partition2 = partitionTurn(parts2, null, partition1)
        const projected2 = projectTurn(partition2, { viewMode: 'normal', streaming: true }, projected1)

        // Earlier rows are reused by reference
        expect(partition2.rows[0]).toBe(partition1.rows[0])
        expect(partition2.rows[1]).toBe(partition1.rows[1])
        // Only the trailing text row updated
        expect(partition2.rows[2]).not.toBe(partition1.rows[2])

        const sub1 = projected1.subturns[0]!
        const sub2 = projected2.subturns[0]!
        expect(sub2.nonTrailingRows).toBe(sub1.nonTrailingRows)
        expect(sub2.stepRows).toBe(sub1.stepRows)
        expect(sub2.collapsedPinnedRailRows).toBe(sub1.collapsedPinnedRailRows)
        expect(sub2.todoChecklists).toBe(sub1.todoChecklists)
        expect(sub2.quietTextRows).toBe(sub1.quietTextRows)
        expect(sub2.mediaRows).toBe(sub1.mediaRows)
        expect(sub2.answerRows[0]?.text).toBe('Here is the first paragraph with more tokens.')
    })
})
