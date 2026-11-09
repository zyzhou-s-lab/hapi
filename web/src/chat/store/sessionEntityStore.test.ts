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
        expect(snapTail.timelineIndex.map((e) => e.id)).toEqual(['user-text:u2', 'agent-text:a2:0', 'user-text:u3', 'agent-text:a3:0'])

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
        expect(snapPrepended.timelineIndex.map((e) => e.id)).toEqual(['user-text:u1', 'agent-text:a1:0', 'user-text:u2', 'agent-text:a2:0', 'user-text:u3', 'agent-text:a3:0'])
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
        expect(snapOtherSession.timelineIndex.map((e) => e.id)).toEqual(['user-text:u-other'])
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

    it('keeps only turn layout and timeline stable while complete turn payloads remain current', () => {
        const store = createSessionEntityStore()
        const userPrompt = makeUserMessage('u-prompt', 'Explain the architecture', 1000)
        const liveDelta1: DecryptedMessage = {
            id: 'a-stream',
            seq: 2,
            localId: null,
            createdAt: 1100,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        id: 'stream-item-ans',
                        turn_id: 'turn-ans',
                        phase: 'final_answer',
                        streamSnapshot: true,
                        live: true,
                        message: 'First token',
                    },
                },
            },
        }
        const snap1 = store.reconcileInput({
            sessionId: 'sess-turn-eq',
            messages: [userPrompt, liveDelta1],
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })
        const turnId = snap1.blocksWithThreadIds.find((e) => e.block.kind === 'agent-text')!.threadMessageId
        const turn1 = store.getTurnEntity(turnId)!
        const layout1 = store.getTurnLayout(turnId)
        expect(turn1).toBeDefined()
        expect(store.getPrecedingUserText(turnId)).toBe('Explain the architecture')

        let turnNotified = 0
        let blockNotified = 0
        const textBlockId = turn1.blocks[0]!.id
        store.subscribeEntity(turnId, () => {
            turnNotified += 1
        })
        store.subscribeEntity(textBlockId, () => {
            blockNotified += 1
        })

        const liveDelta2: DecryptedMessage = {
            ...liveDelta1,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        id: 'stream-item-ans',
                        turn_id: 'turn-ans',
                        phase: 'final_answer',
                        streamSnapshot: true,
                        live: true,
                        message: 'First token and second token',
                    },
                },
            },
        }
        const snap2 = store.reconcileInput({
            sessionId: 'sess-turn-eq',
            messages: [userPrompt, liveDelta2],
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })

        // Complete domain snapshots update; only the payload-free layout and
        // thread topology stay stable. No consumer sees a first-token turn.
        expect(turnNotified).toBe(1)
        expect(blockNotified).toBe(1)
        expect(store.getTurnEntity(turnId)).not.toBe(turn1)
        expect(store.getTurnLayout(turnId)).toBe(layout1)
        expect(snap2.timelineIndex).toBe(snap1.timelineIndex)
        expect(snap2.timelineVersion).toBe(snap1.timelineVersion)
        expect(store.getTurnEntity(turnId)?.parts[0]?.text).toBe('First token and second token')
        expect(store.getLiveTurnParts(turnId)?.[0]).toMatchObject({
            type: 'text',
            text: 'First token and second token',
        })

        // Settlement preserves complete content without relying on a catch-up refresh.
        const settledMsg: DecryptedMessage = {
            ...liveDelta2,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        id: 'stream-item-ans',
                        turn_id: 'turn-ans',
                        phase: 'final_answer',
                        streamSnapshot: true,
                        message: 'First token and second token',
                    },
                },
            },
        }
        store.reconcileInput({
            sessionId: 'sess-turn-eq',
            messages: [userPrompt, settledMsg],
            agentState: null,
            hasMoreMessages: false,
            codexExplorationCollapsed: false,
        })
        expect(turnNotified).toBeGreaterThanOrEqual(1)
        expect(store.getTurnEntity(turnId)?.parts[0]).toMatchObject({
            type: 'text',
            text: 'First token and second token',
        })
    })
    it('keeps one assistant timeline row while blocks, payloads, state and permissions evolve', () => {
        const store = createSessionEntityStore()
        const user = makeUserMessage('u', 'Inspect', 1)
        const first = makeClaudeToolUseMessage('tool', 'tool-uuid', 'call', 'Read', {}, 2)
        const initial = store.reconcileInput({ sessionId: 's', messages: [user, first] })
        const turnId = initial.timelineIndex[1]!.id
        expect(initial.timelineIndex).toEqual([
            { id: 'user-text:u', kind: 'user-text', role: 'user' },
            { id: turnId, kind: 'assistant-turn', role: 'assistant' },
        ])
        const layout = store.getTurnLayout(turnId)
        const payload = makeClaudeToolUseMessage('tool', 'tool-uuid', 'call', 'Read', { file_path: 'a.ts', i: 'Reading implementation' }, 2)
        const withPayload = store.reconcileInput({ sessionId: 's', messages: [user, payload] })
        expect(withPayload.timelineIndex).toBe(initial.timelineIndex)
        expect(withPayload.timelineVersion).toBe(initial.timelineVersion)
        expect(store.getTurnLayout(turnId)).toBe(layout)
        expect(store.getTurnEntity(turnId)?.parts[0]?.artifact).toMatchObject({ tool: { input: { file_path: 'a.ts' } } })
        const withTaskEmpty = store.reconcileInput({ sessionId: 's', messages: [user, payload, makeClaudeToolUseMessage('task-msg', 'task-uuid', 'task-call', 'Task', {}, 3)] })
        const layoutBeforeTasks = store.getTurnLayout(turnId)
        const withTaskPopulated = store.reconcileInput({ sessionId: 's', messages: [user, payload, makeClaudeToolUseMessage('task-msg', 'task-uuid', 'task-call', 'Task', { tasks: [{ task: 'a' }, { task: 'b' }] }, 3)] })
        expect(withTaskPopulated.timelineIndex).toBe(withTaskEmpty.timelineIndex)
        expect(store.getTurnLayout(turnId)).not.toBe(layoutBeforeTasks)
        const withSecondTool = store.reconcileInput({ sessionId: 's', messages: [user, payload, makeClaudeToolUseMessage('tool2', 'uuid2', 'call2', 'Read', { file_path: 'b.ts' }, 3)] })
        expect(withSecondTool.timelineIndex).toBe(initial.timelineIndex)
        expect(withSecondTool.timelineVersion).toBe(initial.timelineVersion)
        expect(store.getTurnLayout(turnId)).not.toBe(layout)
        const completed = store.reconcileInput({ sessionId: 's', messages: [user, payload, makeClaudeToolResultMessage('result', 'result-uuid', 'call', 'line 1\nline 2', 4), makeAssistantTextMessage('final', 'Complete answer', 5)] })
        expect(completed.timelineIndex).toBe(initial.timelineIndex)
        expect(completed.timelineVersion).toBe(initial.timelineVersion)
        expect(store.getLiveTurnParts(turnId)?.at(-1)).toMatchObject({ text: 'Complete answer' })
        const afterRewind = store.reconcileInput({ sessionId: 's', messages: [] })
        expect(afterRewind.timelineIndex).toEqual([])
        expect(afterRewind.timelineVersion).toBe(initial.timelineVersion + 1)
        expect(store.getTurnEntity(turnId)).toBeUndefined()
        expect(store.getTurnLayout(turnId)).toBeUndefined()
        store.reset('other')
        expect(store.getSnapshot().timelineVersion).toBe(0)
    })

    it('builds topology after flavor filtering and title hoisting, retaining every user and system boundary', () => {
        const store = createSessionEntityStore()
        const event = (id: string, data: Record<string, unknown>, seq: number): DecryptedMessage => ({
            id, seq, localId: null, createdAt: seq * 1000,
            content: { role: 'agent', content: { type: 'event', data } },
        })
        const snapshot = store.reconcileInput({ sessionId: 's', metadata: { flavor: 'omp', path: '/repo', host: 'test' }, messages: [
            makeUserMessage('u1', 'Question', 1), makeAssistantTextMessage('a', 'Answer', 2),
            event('title', { type: 'title-changed', title: 'New title' }, 3),
            makeAssistantTextMessage('b', 'More answer', 4),
            event('ready', { type: 'ready' }, 5), makeUserMessage('u2', 'Next', 6),
        ] })
        const assistant = snapshot.timelineIndex.filter((entry) => entry.role === 'assistant')
        expect(assistant).toHaveLength(1)
        expect(snapshot.turnsById.get(assistant[0]!.id)?.parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual(['Answer', 'More answer'])
        expect(snapshot.timelineIndex.filter((entry) => entry.role === 'user').map((entry) => entry.id)).toEqual(['user-text:u1', 'user-text:u2'])
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
