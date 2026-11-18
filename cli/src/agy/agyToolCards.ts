import type { AgentMessage } from '@/agent/types';
import { sanitizeMcpServerToken } from '@/modules/common/sessionInventory';

type ToolCall = Extract<AgentMessage, { type: 'tool_call' }>;
type ToolResult = Extract<AgentMessage, { type: 'tool_result' }>;

/**
 * agy's `agy acp` titles its tool calls with free text (the command line,
 * `File notes.md`, `Run invoke_subagent`), so no web card matches them. It
 * also sends its own tool name and args, which identify the tool; this maps
 * them to the canonical cards the other flavors use. Names differ from agy's
 * stream-json tools (read_file / edit_file / write_file there are view_file /
 * replace_file_content / write_to_file).
 */

/** Shown for a command agy moved to the background until its real result arrives. */
export const AGY_BACKGROUND_COMMAND_RESULT = {
    stdout: 'Running in the background. The result appears when agy reports it.'
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asText(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

/** Like compact, but keeps '' for fields where empty is meaningful (deleted text, an empty file). */
function compactKeepingEmpty(input: Record<string, unknown>, keep: string[]): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).filter(([key, value]) =>
        value !== undefined && value !== null && (value !== '' || keep.includes(key))
    ));
}

function parseArguments(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
        try {
            return asRecord(JSON.parse(value)) ?? {};
        } catch {
            return {};
        }
    }
    return asRecord(value) ?? {};
}

/** An artifact write (plan, task list) lives in agy's private brain directory. */
function artifactPlan(args: Record<string, unknown>): string | null {
    const metadata = asRecord(args.ArtifactMetadata);
    if (!metadata) return null;
    const content = asText(args.Content) ?? '';
    const summary = asText(metadata.Summary);
    if (!summary || /^\s*#/.test(content)) return content;
    return `# ${summary}\n\n${content}`;
}

export function parseAgyEagerMcpToolName(
    nativeName: string,
    knownServers?: Iterable<string>
): { server: string; tool: string } | null {
    if (!nativeName.startsWith('mcp_') || nativeName.startsWith('mcp__')) {
        return null;
    }
    const rest = nativeName.slice('mcp_'.length);
    if (knownServers) {
        const sortedServers = [...knownServers]
            .filter(Boolean)
            .sort((a, b) => {
                const lenDiff = sanitizeMcpServerToken(b).length - sanitizeMcpServerToken(a).length;
                return lenDiff !== 0 ? lenDiff : b.length - a.length;
            });
        for (const server of sortedServers) {
            const exactPrefix = `${server}_`;
            if (rest.startsWith(exactPrefix) && rest.length > exactPrefix.length) {
                return { server, tool: rest.slice(exactPrefix.length) };
            }
            const sanitizedPrefix = `${sanitizeMcpServerToken(server)}_`;
            if (rest.startsWith(sanitizedPrefix) && rest.length > sanitizedPrefix.length) {
                return { server, tool: rest.slice(sanitizedPrefix.length) };
            }
        }
    }
    const sepIdx = rest.indexOf('_');
    if (sepIdx <= 0 || sepIdx >= rest.length - 1) {
        return null;
    }
    return {
        server: rest.slice(0, sepIdx),
        tool: rest.slice(sepIdx + 1)
    };
}

export function mapAgyPermissionRequestTool(
    request: {
        title?: string | null;
        kind?: string | null;
        rawInput?: unknown;
        nativeName?: string;
        nativeArgs?: unknown;
    },
    fallbackNativeName?: string,
    knownServers?: Iterable<string>
): { toolName: string; toolInput: unknown } | null {
    if (request.kind?.trim().toLowerCase() === 'execute') {
        return null;
    }
    const titleMatch = typeof request.title === 'string'
        ? /^(?:Run\s+)?(mcp_[^\s]+|call_mcp_tool)$/.exec(request.title.trim())
        : null;
    const candidate = request.nativeName?.trim() || fallbackNativeName?.trim() || titleMatch?.[1] || '';
    if (!candidate) {
        return null;
    }
    if (candidate === 'call_mcp_tool') {
        const raw = asRecord(request.nativeArgs) ?? asRecord(request.rawInput);
        const server = asText(raw?.ServerName);
        const tool = asText(raw?.ToolName);
        if (!server || !tool) {
            return {
                toolName: 'call_mcp_tool',
                toolInput: raw ?? {}
            };
        }
        return {
            toolName: `mcp__${server}__${tool}`,
            toolInput: parseArguments(raw?.Arguments)
        };
    }
    const eager = parseAgyEagerMcpToolName(candidate, knownServers);
    if (eager) {
        return {
            toolName: `mcp__${eager.server}__${eager.tool}`,
            toolInput: asRecord(request.nativeArgs) ?? asRecord(request.rawInput) ?? request.rawInput ?? {}
        };
    }
    return null;
}

export function mapAgyToolCall(message: ToolCall, knownServers?: Iterable<string>): ToolCall {
    if (!message.nativeName) return message;
    const args = asRecord(message.nativeArgs);
    const eagerMcp = parseAgyEagerMcpToolName(message.nativeName, knownServers);
    if (eagerMcp) {
        return {
            ...message,
            name: `mcp__${eagerMcp.server}__${eagerMcp.tool}`,
            input: args ?? asRecord(message.input) ?? {}
        };
    }
    if (!args) return message;

    let name: string;
    let input: Record<string, unknown>;
    switch (message.nativeName) {
        case 'run_command':
            name = 'Bash';
            input = compact({
                command: args.CommandLine,
                cwd: args.Cwd,
                description: args.toolSummary
            });
            break;
        case 'read_file':
            name = 'Read';
            input = compact({ file_path: args.Path });
            break;
        case 'edit_file':
            name = 'Edit';
            input = compactKeepingEmpty(
                { file_path: args.Path, old_string: args.Target, new_string: args.Replacement },
                ['old_string', 'new_string']
            );
            break;
        case 'write_file': {
            const plan = artifactPlan(args);
            if (plan !== null) {
                name = 'ExitPlanMode';
                input = { plan };
            } else {
                name = 'Write';
                input = compactKeepingEmpty({ file_path: args.Path, content: args.Content }, ['content']);
            }
            break;
        }
        case 'search_web':
            name = 'WebSearch';
            input = compact({ query: args.query });
            break;
        case 'invoke_subagent':
            name = 'Task';
            input = compact({ description: args.Role, prompt: args.Prompt, subagent_type: args.TypeName });
            break;
        case 'swarm': {
            const action = asText(args.action);
            if (action === 'add') {
                const workerName = asText(args.name);
                name = 'Task';
                input = compact({
                    description: workerName ? `Swarm worker: @${workerName}` : 'Swarm worker',
                    prompt: args.brief,
                    subagent_type: args.model
                });
                break;
            }
            if (action === 'title') {
                name = 'TeamCreate';
                input = compact({ team_name: args.title });
                break;
            }
            if (action === 'kill') {
                name = 'close_agent';
                input = compact({ target: args.name });
                break;
            }
            if (action === 'status' || action === 'models') {
                name = 'list_agents';
                input = compact({ path_prefix: action });
                break;
            }
            if (action === 'model') {
                const target = asText(args.name) ?? 'coordinator';
                return {
                    ...message,
                    name: 'swarm',
                    title: `Switch @${target} model`,
                    input: compact({ name: asText(args.model) })
                };
            }
            return message;
        }
        case 'post_message': {
            const channel = asText(args.channel);
            name = 'SendMessage';
            input = compact({
                recipient: channel ? `#${channel}` : 'swarm board',
                summary: args.text
            });
            break;
        }
        case 'send_message':
            name = 'SendMessage';
            input = compact({
                recipient: args.Recipient,
                summary: args.Message
            });
            break;
        case 'swarm_wait': {
            const target = typeof args.since === 'number' && Number.isFinite(args.since)
                ? `board > #${args.since}`
                : 'swarm board';
            name = 'wait_agent';
            input = compact({ target });
            break;
        }
        case 'read_board': {
            const channel = asText(args.channel);
            const since = typeof args.since === 'number' && Number.isFinite(args.since)
                ? `since #${args.since}`
                : undefined;
            return {
                ...message,
                name: 'read_board',
                title: channel ? `Read swarm board (#${channel})` : 'Read swarm board',
                input: compact({ name: since ?? channel })
            };
        }
        case 'call_mcp_tool': {
            const server = asText(args.ServerName);
            const tool = asText(args.ToolName);
            if (!server || !tool) return message;
            name = `mcp__${server}__${tool}`;
            input = parseArguments(args.Arguments);
            break;
        }
        default:
            return message;
    }

    // An artifact plan must not leak the brain path through the title.
    if (name === 'ExitPlanMode') {
        const { title: _title, ...rest } = message;
        return { ...rest, name, input };
    }
    return { ...message, name, input };
}

/** agy frames a command result as "Command exited with code N.\n\nCommand output:\n<text>". */
export function mapAgyToolResult(message: ToolResult, nativeName: string | undefined): ToolResult {
    if (nativeName !== 'run_command') return message;
    const output = asRecord(message.output);
    const text = asText(output?.output);
    if (!output || text === undefined) return message;
    const body = text
        .replace(/\r\n/g, '\n')
        .replace(/^Command exited with code -?\d+\.\s*\n\s*Command output:\n?/, '')
        .trimEnd();
    return {
        ...message,
        output: {
            stdout: body,
            ...(typeof output.exit_code === 'number' ? { exit_code: output.exit_code } : {})
        }
    };
}
