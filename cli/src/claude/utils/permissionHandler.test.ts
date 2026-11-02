import { describe, expect, it, vi } from 'vitest';
import type { EnhancedMode } from '../loop';
import type { SDKMessage } from '../sdk';
import { PermissionHandler } from './permissionHandler';
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from '../sdk/prompts';
import type { Session } from '../session';

function createFakeSession() {
    const queueItems: { message: string; mode: unknown }[] = [];
    const rpcHandlers = new Map<string, (payload: {
        id: string
        approved?: boolean
        decision?: string
        allowTools?: string[]
    }) => Promise<unknown> | unknown>();
    let permissionMode: string | undefined;

    const session = {
        client: {
            rpcHandlerManager: {
                registerHandler: vi.fn((_method: string, handler: (payload: {
                    id: string
                    approved?: boolean
                    decision?: string
                    allowTools?: string[]
                }) => Promise<unknown> | unknown) => {
                    rpcHandlers.set('permission', handler);
                }),
            },
            updateAgentState: vi.fn(),
        },
        queue: {
            unshift: vi.fn((message: string, mode: unknown) => {
                queueItems.push({ message, mode });
            }),
        },
        setPermissionMode: vi.fn((mode: string) => {
            permissionMode = mode;
        }),
        getPermissionMode: vi.fn(() => permissionMode),
    } as unknown as Session;

    return { session, queueItems, rpcHandlers };
}

describe('PermissionHandler — YOLO plan mode', () => {
    it('injects PLAN_FAKE_RESTART and denies exit_plan_mode in bypassPermissions', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        // Simulate Claude emitting an assistant message with exit_plan_mode tool_use
        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-1', name: 'exit_plan_mode', input: {} }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'exit_plan_mode',
            {},
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        // Should deny with PLAN_FAKE_REJECT (so Claude restarts)
        expect(result.behavior).toBe('deny');
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });

        // Should inject PLAN_FAKE_RESTART into the queue
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].message).toBe(PLAN_FAKE_RESTART);
        expect(queueItems[0].mode).toEqual({ permissionMode: 'bypassPermissions' });
    });

    it('injects PLAN_FAKE_RESTART for ExitPlanMode variant', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-2', name: 'ExitPlanMode', input: {} }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'ExitPlanMode',
            {},
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('deny');
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].message).toBe(PLAN_FAKE_RESTART);
    });

    it('allows normal tools in bypassPermissions without queue injection', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-3', name: 'Bash', input: { command: 'ls' } }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'ls' },
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('allow');
        expect(queueItems).toHaveLength(0);
    });

    // Regression: turn-in-progress switch from default to bypassPermissions via
    // SetSessionConfig RPC updates session.setPermissionMode but doesn't go
    // through handler.handleModeChange. The next canCallTool must reflect the
    // new mode. See issue #735.
    it('reflects session permission mode changes between tool calls', async () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('default');

        // Simulate RPC handler in runClaude updating the session directly,
        // bypassing handler.handleModeChange (as happens on web dropdown change).
        session.setPermissionMode('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-4', name: 'Bash', input: { command: 'ls' } }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'ls' },
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('allow');
    });
});

describe('PermissionHandler — delete_exploration', () => {
    it('asks on every call in bypassPermissions and ignores a session grant', async () => {
        const { session, rpcHandlers } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');
        const input = { lineId: 'line-1' };
        const mode: EnhancedMode = { permissionMode: 'bypassPermissions' };
        const toolMessage = (id: string): SDKMessage => ({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id, name: 'mcp__hapi__delete_exploration', input }],
            },
        });

        const bash = await handler.handleToolCall(
            'Bash',
            { command: 'ls' },
            mode,
            { signal: new AbortController().signal }
        );
        expect(bash.behavior).toBe('allow');

        handler.onMessage(toolMessage('tc-del'));
        let settled = false;
        const pending = handler.handleToolCall(
            'mcp__hapi__delete_exploration',
            input,
            mode,
            { signal: new AbortController().signal }
        ).then((result) => {
            settled = true;
            return result;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        await rpcHandlers.get('permission')?.({
            id: 'tc-del',
            approved: true,
            decision: 'approved_for_session',
            allowTools: ['mcp__hapi__delete_exploration'],
        });
        await expect(pending).resolves.toMatchObject({ behavior: 'allow' });

        handler.onMessage(toolMessage('tc-del-2'));
        const second = new AbortController();
        let secondSettled = false;
        const again = handler.handleToolCall(
            'mcp__hapi__delete_exploration',
            input,
            mode,
            { signal: second.signal }
        ).then((result) => {
            secondSettled = true;
            return result;
        }, (error: unknown) => {
            secondSettled = true;
            throw error;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(secondSettled).toBe(false);
        second.abort();
        await expect(again).rejects.toThrow('Permission request aborted');
    });
});
