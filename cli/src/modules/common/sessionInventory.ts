import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { logger } from '@/ui/logger';
import {
    type SessionInventory,
    type SessionInventoryHook,
    type SessionInventoryMcpServer,
    type SessionInventoryAgent,
    type SessionInventorySkill,
    type SessionInventorySource,
} from '@hapi/protocol/schemas';
import { buildHookSettings, readMachineClaudeSettings } from '@/modules/common/hooks/generateHookSettings';
import { listInventorySkills } from '@/modules/common/skills';
import { collectSessionPrompts, getSessionPromptLive, type SessionPromptLive } from './sessionPrompts';
import { cachedProbe, checkMcpServers, probeTargetsFromConfig, type McpProbeTarget } from './mcpServerCheck';
import { lineOfJsonKey, lineOfSnippet, listedConfigFilePath, tryRealpath } from './configFilePath';

const MAX_CONFIG_BYTES = 1_000_000;
const SOURCE_RANK: Record<SessionInventorySource, number> = {
    tool: 1,
    user: 2,
    system: 3,
    project: 4,
    plugin: 5,
    injected: 6,
};

export type LiveSessionConfig = SessionInventory;
type SessionInventoryPatch = LiveSessionConfig;

const SECRET_TEXT = /token|api[_-]?key|secret|password|bearer|authorization/i;

export function isSafeInventoryName(value: string): boolean {
    const name = value.trim();
    if (!name || name.length > 200) return false;
    if (/[\r\n\0]/.test(name)) return false;
    if (/:\/\//.test(name)) return false;
    if (SECRET_TEXT.test(name)) return false;
    return true;
}

const COMMAND_WRAPPERS: Record<string, true> = {
    bash: true,
    sh: true,
    zsh: true,
    node: true,
    nodejs: true,
    npx: true,
    env: true,
};

function commandTokens(command: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (const match of command.matchAll(pattern)) {
        const token = match[1] ?? match[2] ?? match[3] ?? '';
        if (token.length > 0) tokens.push(token);
    }
    return tokens;
}

function tokenBasename(token: string): string {
    const stripped = token.replace(/^['"]|['"]$/g, '');
    return stripped.split(/[/\\]/).pop() ?? stripped;
}

export function commandBasename(command: string): string | undefined {
    if (command.includes('hook-forwarder')) return 'hook-forwarder';
    let tokens = commandTokens(command.trim());
    for (let pass = 0; pass < 4 && tokens.length > 0; pass++) {
        const head = tokenBasename(tokens[0]).toLowerCase();
        if (!COMMAND_WRAPPERS[head]) break;
        if (head === 'env') {
            let index = 1;
            while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
            tokens = tokens.slice(index);
            continue;
        }
        if (head === 'npx') {
            let index = 1;
            while (index < tokens.length && tokens[index].startsWith('-')) index++;
            tokens = tokens.slice(index);
            continue;
        }
        if (head === 'node' || head === 'nodejs') {
            let index = 1;
            while (index < tokens.length && tokens[index].startsWith('-')) {
                const flag = tokens[index];
                if (flag === '-e' || flag === '--eval' || flag === '-p' || flag === '--print') {
                    return undefined;
                }
                index++;
                if (flag === '-r' || flag === '--require' || flag === '--import' || flag === '--loader') index++;
            }
            tokens = tokens.slice(index);
            continue;
        }
        let index = 1;
        let dashC = false;
        while (index < tokens.length && tokens[index].startsWith('-')) {
            const flag = tokens[index];
            if (flag === '-c' || flag === '--command' || /^-[^-]*c/.test(flag)) dashC = true;
            index++;
        }
        tokens = dashC && index < tokens.length ? commandTokens(tokens[index]) : tokens.slice(index);
    }
    const base = tokens[0] ? tokenBasename(tokens[0]) : '';
    if (!isSafeInventoryName(base) || base.length > 80) return undefined;
    return base;
}

export function safeMatcher(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const matcher = value.trim();
    if (!isSafeInventoryName(matcher) || matcher.length > 120) return undefined;
    return matcher;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function isSource(value: string | undefined): value is SessionInventorySource {
    return value === 'injected'
        || value === 'user'
        || value === 'project'
        || value === 'plugin'
        || value === 'system'
        || value === 'tool';
}

export function redactStoredText(value: string | undefined, max: number): string | undefined {
    if (!value) return undefined;
    const redacted = value
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\b(?:token|api[_-]?key|secret|password|bearer)\b\s*[:=]\s*\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
    return redacted.length > 0 ? redacted : undefined;
}

export function dedupeServers(servers: readonly SessionInventoryMcpServer[]): SessionInventoryMcpServer[] {
    const byName = new Map<string, SessionInventoryMcpServer>();
    for (const server of servers) {
        if (!isSafeInventoryName(server.name)) continue;
        const name = server.name.trim();
        const previous = byName.get(name);
        if (!previous || SOURCE_RANK[server.source] >= SOURCE_RANK[previous.source]) {
            byName.set(name, {
                name,
                source: server.source,
                ...(server.enabled === false ? { enabled: false } : {}),
                ...(server.loaded !== undefined ? { loaded: server.loaded } : {}),
                ...(server.filePath ? { filePath: server.filePath } : {}),
                ...(server.line ? { line: server.line } : {}),
            });
        }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 200);
}

export function dedupeHooks(items: readonly SessionInventoryHook[]): SessionInventoryHook[] {
    const byKey = new Map<string, SessionInventoryHook>();
    for (const item of items) {
        const event = item.event.trim();
        if (!isSafeInventoryName(event) || event.length > 80) continue;
        const matcher = item.matcher && isSafeInventoryName(item.matcher) ? item.matcher.trim() : undefined;
        const commandName = item.commandName && isSafeInventoryName(item.commandName)
            ? item.commandName.trim().slice(0, 80)
            : undefined;
        const index = typeof item.index === 'number' ? item.index : 0;
        const next: SessionInventoryHook = {
            event,
            source: item.source,
            ...(matcher ? { matcher } : {}),
            ...(commandName ? { commandName } : {}),
            ...(index > 0 ? { index } : {}),
            ...(item.enabled === false ? { enabled: false } : {}),
            ...(item.filePath ? { filePath: item.filePath } : {}),
            ...(item.line ? { line: item.line } : {}),
            ...(item.scriptPath ? { scriptPath: item.scriptPath } : {}),
        };
        const key = `${next.event}\0${next.matcher ?? ''}\0${next.source}\0${next.commandName ?? ''}\0${index}`;
        const previous = byKey.get(key);
        if (!previous || SOURCE_RANK[next.source] >= SOURCE_RANK[previous.source]) {
            byKey.set(key, next);
        }
    }
    return [...byKey.values()].slice(0, 400);
}

const SCRIPT_EXTENSIONS: Record<string, true> = {
    '.js': true, '.mjs': true, '.cjs': true, '.ts': true, '.tsx': true,
    '.sh': true, '.bash': true, '.zsh': true, '.py': true, '.rb': true, '.pl': true,
};

type ConfigFileOrigin = {
    file: string;
    cwd: string;
    text: string;
    source?: SessionInventorySource;
};

function publishFilePath(filePath: string | undefined): string | undefined {
    if (!filePath || filePath.split(/[\\/]/).includes('..') || filePath.length > 4096) return undefined;
    return filePath;
}

function fileLocation(origin: ConfigFileOrigin | undefined, key: string): { filePath?: string; line?: number } {
    if (!origin) return {};
    const filePath = listedConfigFilePath(origin.file, origin.cwd);
    if (!filePath) return {};
    const line = lineOfJsonKey(origin.text, key) ?? lineOfSnippet(origin.text, key);
    return { filePath, ...(line ? { line } : {}) };
}

function hookScriptPath(command: string, cwd: string): string | undefined {
    const tokens = command.match(/"([^"]*)"|'([^']*)'|(\S+)/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
    for (const token of tokens) {
        if (!(isAbsolute(token) || token.startsWith('.'))) continue;
        const candidate = isAbsolute(token) ? token : resolve(cwd, token);
        const listed = listedConfigFilePath(candidate, cwd);
        if (!listed) continue;
        const real = tryRealpath(isAbsolute(listed) ? listed : resolve(cwd, listed));
        if (!real) continue;
        try {
            const info = statSync(real);
            if (!info.isFile() || info.size > MAX_CONFIG_BYTES) continue;
            if ((info.mode & 0o111) === 0 && !SCRIPT_EXTENSIONS[extname(real).toLowerCase()]) continue;
            return listed;
        } catch {
            continue;
        }
    }
    return undefined;
}

function jsonServersFromFile(path: string, cwd: string, source: SessionInventorySource, allowSymlink = false): SessionInventoryMcpServer[] {
    const text = readTextFile(path, { allowSymlink });
    if (!text) return [];
    try {
        return mcpServersFromConfig(JSON.parse(text) as unknown, source, { file: path, cwd, text });
    } catch {
        return [];
    }
}

function hooksFromFile(path: string, cwd: string, source: SessionInventorySource): SessionInventoryHook[] {
    const text = readTextFile(path);
    if (!text) return [];
    try {
        return hooksFromClaudeSettings(JSON.parse(text) as unknown, { file: path, cwd, text, source });
    } catch {
        return [];
    }
}

export function inventorySkills(
    skills: readonly { name: string; description?: string; source?: string; enabled?: boolean; filePath?: string }[],
    options?: { catalogUnavailable?: boolean }
): NonNullable<SessionInventory['skills']> {
    const items: SessionInventorySkill[] = [];
    for (const skill of skills) {
        const name = skill.name.trim();
        if (!isSafeInventoryName(name)) continue;
        const description = redactStoredText(skill.description, 500);
        const source = isSource(skill.source) ? skill.source : undefined;
        items.push({
            name,
            ...(description ? { description } : {}),
            ...(source ? { source } : {}),
            ...(skill.enabled === false ? { enabled: false } : {}),
            ...(publishFilePath(skill.filePath) ? { filePath: publishFilePath(skill.filePath) } : {}),
        });
        if (items.length >= 400) break;
    }
    return {
        ...(options?.catalogUnavailable ? { catalogUnavailable: true } : {}),
        items,
    };
}

export function mcpServersFromConfig(value: unknown, source: SessionInventorySource, origin?: ConfigFileOrigin): SessionInventoryMcpServer[] {
    const servers = asRecord(asRecord(value).mcpServers);
    return Object.keys(servers)
        .filter((name) => isSafeInventoryName(name))
        .map((name) => {
            const disabled = asRecord(servers[name]).disabled === true;
            return {
                name: name.trim(),
                source,
                ...(disabled ? { enabled: false as const } : {}),
                ...fileLocation(origin, name.trim()),
            };
        });
}

export function mcpServersFromClaudeJson(value: unknown, cwd: string): SessionInventoryMcpServer[] {
    const root = asRecord(value);
    const items = mcpServersFromConfig(root, 'user');
    const resolvedCwd = resolve(cwd);
    for (const [projectPath, projectValue] of Object.entries(asRecord(root.projects))) {
        const projectResolved = resolve(projectPath);
        const matches = projectResolved === resolvedCwd || resolvedCwd.startsWith(projectResolved + sep);
        if (!matches) continue;
        items.push(...mcpServersFromConfig(projectValue, 'project'));
    }
    return items;
}

export function hooksFromClaudeSettings(settings: unknown, origin?: ConfigFileOrigin): SessionInventoryHook[] {
    const hooks = asRecord(asRecord(settings).hooks);
    const items: SessionInventoryHook[] = [];
    const seen = new Map<string, number>();
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
            const record = asRecord(group);
            const matcher = safeMatcher(record.matcher);
            const commands = Array.isArray(record.hooks) ? record.hooks : [record];
            for (const commandEntry of commands) {
                const commandRecord = asRecord(commandEntry);
                const command = commandRecord.command;
                if (typeof command !== 'string' || command.trim().length === 0) continue;
                const commandName = commandBasename(command);
                const source = command.includes('hook-forwarder') ? 'injected' : (origin?.source ?? 'user');
                const identity = `${event}\0${matcher ?? ''}\0${source}\0${commandName ?? ''}`;
                const index = seen.get(identity) ?? 0;
                seen.set(identity, index + 1);
                const scriptPath = origin && source !== 'injected' ? hookScriptPath(command, origin.cwd) : undefined;
                items.push({
                    event,
                    source,
                    ...(matcher ? { matcher } : {}),
                    ...(commandName ? { commandName } : {}),
                    ...(index > 0 ? { index } : {}),
                    ...(commandRecord.disabled === true ? { enabled: false } : {}),
                    ...(source === 'injected' ? {} : fileLocation(origin, command)),
                    ...(scriptPath ? { scriptPath } : {}),
                });
            }
        }
    }
    return dedupeHooks(items);
}

export function parseCodexConfigInventory(toml: string, cwd?: string): {
    servers: SessionInventoryMcpServer[];
    hooks: SessionInventoryHook[];
} {
    const servers: SessionInventoryMcpServer[] = [];
    const hooks: SessionInventoryHook[] = [];
    const hookCounts = new Map<string, number>();
    let section: { kind: 'server' | 'hook'; name: string } | null = null;
    const disableLast = (kind: 'server' | 'hook', name: string) => {
        const items = kind === 'server' ? servers : hooks;
        for (let index = items.length - 1; index >= 0; index--) {
            const item = items[index];
            const matches = kind === 'server'
                ? 'name' in item && item.name === name
                : 'event' in item && item.event === name;
            if (!matches) continue;
            item.enabled = false;
            return;
        }
    };
    let lineNo = 0;
    for (const rawLine of toml.split(/\r?\n/)) {
        lineNo += 1;
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const table = /^\[\[?([^\]\s]+)\]\]?$/.exec(line);
        if (table) {
            const key = table[1] ?? '';
            const server = /^mcp_servers\.([^.[\]]+)/.exec(key);
            const hook = /^hooks\.([^.[\]]+)/.exec(key);
            const exact = !key.slice(key.indexOf('.') + 1).includes('.');
            if (server?.[1] && isSafeInventoryName(server[1])) {
                section = exact ? { kind: 'server', name: server[1] } : null;
                servers.push({ name: server[1], source: 'user', line: lineNo });
            } else if (hook?.[1] && isSafeInventoryName(hook[1])) {
                const index = hookCounts.get(hook[1]) ?? 0;
                hookCounts.set(hook[1], index + 1);
                section = exact ? { kind: 'hook', name: hook[1] } : null;
                hooks.push({ event: hook[1], source: 'user', line: lineNo, ...(index > 0 ? { index } : {}) });
            } else {
                section = null;
            }
            continue;
        }
        const command = /^command\s*=\s*"([^"]*)"/.exec(line);
        if (section?.kind === 'hook' && command?.[1] && cwd) {
            const scriptPath = hookScriptPath(command[1], cwd);
            const hook = hooks[hooks.length - 1];
            if (scriptPath && hook && hook.event === section.name) hook.scriptPath = scriptPath;
        }
        if (section && /^enabled\s*=\s*false\b/.test(line)) disableLast(section.kind, section.name);
    }
    return { servers: dedupeServers(servers), hooks: dedupeHooks(hooks) };
}

export function codexInjectedHooks(): SessionInventoryHook[] {
    return [
        { event: 'SessionStart', source: 'injected', commandName: 'hook-forwarder' },
        { event: 'PreToolUse', source: 'injected', matcher: '*', commandName: 'hook-forwarder' },
        { event: 'PostToolUse', source: 'injected', matcher: '*', commandName: 'hook-forwarder' },
    ];
}

/** `mcp__<server>__<tool>`. The server is the text before the first `__`, so a name like `a__b` is reported as `a`. */
export function mcpServerNameFromTool(tool: string): string | undefined {
    if (!tool.startsWith('mcp__')) return undefined;
    const rest = tool.slice('mcp__'.length);
    if (!rest) return undefined;
    const server = rest.includes('__') ? rest.slice(0, rest.indexOf('__')) : rest;
    return isSafeInventoryName(server) ? server : undefined;
}

/** Configured servers stay. A reported tool list sets `loaded` and adds servers that are running but not in a config file. */
export function withMcpLoadState(servers: readonly SessionInventoryMcpServer[], tools: readonly string[] | undefined): SessionInventoryMcpServer[] {
    if (!tools) return [...servers];
    const loaded = new Set(tools.flatMap((tool) => {
        const name = mcpServerNameFromTool(tool);
        return name ? [name] : [];
    }));
    const known = new Set(servers.map((server) => server.name));
    const extras = [...loaded].filter((name) => !known.has(name)).map((name) => ({ name, source: 'tool' as const }));
    return dedupeServers([...servers, ...extras]).map((server) => ({ ...server, loaded: loaded.has(server.name) }));
}

function ompProbeTargets(cwd: string): McpProbeTarget[] {
    const dir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent');
    const seen = new Set<string>();
    const targets: McpProbeTarget[] = [];
    // omp 18.12.6 keeps the first definition. Native project .omp/mcp.json, then
    // .omp/.mcp.json, then the user file. Root .mcp.json stays last.
    for (const path of [...ompProjectMcpPaths(cwd), join(dir, 'mcp.json'), join(dir, 'settings.json'), ...projectMcpPaths(cwd)]) {
        const text = readTextFile(path);
        if (!text) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            continue;
        }
        for (const target of probeTargetsFromConfig(parsed)) {
            if (seen.has(target.name)) continue;
            seen.add(target.name);
            targets.push({ ...target, cwd: resolve(cwd, target.cwd ?? '.') });
        }
    }
    return targets;
}

/** User servers are checked. A project server is only checked when `check` names it; a cached project result is shown without starting it. */
async function withOmpCheckedLoadState(
    servers: readonly SessionInventoryMcpServer[],
    tools: readonly string[] | undefined,
    cwd: string,
    options?: { fresh?: boolean; check?: string },
): Promise<SessionInventoryMcpServer[]> {
    const known = new Set(servers.map((server) => server.name));
    const extras = tools
        ? withMcpLoadState([], tools).filter((server) => !known.has(server.name))
        : [];
    const byName = new Map(ompProbeTargets(cwd).map((target) => [target.name, target]));
    const selected = options?.check?.trim();
    const probing: McpProbeTarget[] = [];
    const cachedProject = new Map<string, boolean>();
    for (const server of servers) {
        if (server.enabled === false) continue;
        const target = byName.get(server.name);
        if (!target) continue;
        if (server.source === 'project' && selected !== server.name) {
            const hit = cachedProbe(target);
            if (hit === undefined) continue;
            if (options?.fresh) {
                probing.push(target);
                continue;
            }
            cachedProject.set(server.name, hit);
            continue;
        }
        probing.push(target);
    }
    const loaded = await checkMcpServers(probing, { fresh: options?.fresh === true });
    return [
        ...servers.map((server) => {
            if (server.enabled === false) return { ...server, loaded: false as const };
            if (loaded.has(server.name)) return { ...server, loaded: loaded.get(server.name) === true };
            if (cachedProject.has(server.name)) return { ...server, loaded: cachedProject.get(server.name) === true };
            if (server.source === 'project') {
                const { loaded: _loaded, ...rest } = server;
                return rest;
            }
            return { ...server, loaded: false as const };
        }),
        ...extras,
    ];
}

export function ompInventoryFromTools(tools: readonly string[]): SessionInventoryPatch {
    const servers = dedupeServers(tools.flatMap((tool) => {
        const name = mcpServerNameFromTool(tool);
        return name ? [{ name, source: 'tool' as const }] : [];
    }));
    return {
        mcp: { kind: 'tools', servers },
        hooks: { availability: 'none', items: [] },
    };
}

function keepFirstServers(servers: readonly SessionInventoryMcpServer[]): SessionInventoryMcpServer[] {
    const byName = new Map<string, SessionInventoryMcpServer>();
    for (const server of servers) {
        if (!isSafeInventoryName(server.name)) continue;
        const name = server.name.trim();
        if (byName.has(name)) continue;
        byName.set(name, {
            name,
            source: server.source,
            ...(server.enabled === false ? { enabled: false } : {}),
            ...(server.loaded !== undefined ? { loaded: server.loaded } : {}),
            ...(server.filePath ? { filePath: server.filePath } : {}),
            ...(server.line ? { line: server.line } : {}),
        });
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 200);
}

function loadOmpInventory(cwd: string): SessionInventoryPatch {
    const dir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent');
    // Same order as ompProbeTargets: native project, then user, then root .mcp.json.
    // First name wins, matching omp. SOURCE_RANK would let the root file beat the user file.
    const servers = keepFirstServers([
        ...ompProjectMcpPaths(cwd).flatMap((path) => jsonServersFromFile(path, cwd, 'project')),
        ...jsonServersFromFile(join(dir, 'mcp.json'), cwd, 'user'),
        ...jsonServersFromFile(join(dir, 'settings.json'), cwd, 'user'),
        ...projectMcpPaths(cwd).flatMap((path) => jsonServersFromFile(path, cwd, 'project')),
    ]);
    return {
        mcp: { kind: 'servers', servers },
        hooks: { availability: 'none', items: [] },
    };
}

export const EMPTY_FLAVOR_INVENTORY: SessionInventoryPatch = {
    mcp: { kind: 'servers', servers: [] },
    hooks: { availability: 'none', items: [] },
};

export function bridgeInventory(flavor: string): SessionInventoryPatch | null {
    if (flavor !== 'copilot' && flavor !== 'grok' && flavor !== 'kimi' && flavor !== 'opencode') {
        return null;
    }
    return {
        mcp: { kind: 'servers', servers: [{ name: 'hapi', source: 'injected' }] },
        ...(flavor === 'opencode'
            ? {}
            : { hooks: { availability: 'none' as const, items: [] } }),
    };
}

export const OPENCODE_HOOK_INVENTORY: SessionInventoryPatch = {
    hooks: {
        availability: 'listed',
        items: [{ event: 'plugin', source: 'injected', commandName: 'hapi-hook' }],
    },
};

function readTextFile(path: string, options?: { allowSymlink?: boolean }): string | null {
    try {
        const linked = lstatSync(path);
        if (!linked.isFile() && !(options?.allowSymlink && linked.isSymbolicLink())) return null;
        if (linked.isSymbolicLink() && !options?.allowSymlink) return null;
        const info = statSync(path);
        if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null;
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

function readJsonFile(path: string, options?: { allowSymlink?: boolean }): unknown {
    const text = readTextFile(path, options);
    if (text === null) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

export function projectMcpPaths(cwd: string, home = homedir()): string[] {
    return walkProjectDirs(cwd, home).map((dir) => join(dir, '.mcp.json'));
}

/** Native project MCP files, closer directory first. omp reads `<cwd>/.omp/mcp.json` then `.omp/.mcp.json`; this walk continues to the git root. */
export function ompProjectMcpPaths(cwd: string, home = homedir()): string[] {
    return walkProjectDirs(cwd, home).flatMap((dir) => [join(dir, '.omp', 'mcp.json'), join(dir, '.omp', '.mcp.json')]);
}

function walkProjectDirs(cwd: string, home: string): string[] {
    const dirs: string[] = [];
    let current = resolve(cwd);
    const seen = new Set<string>();
    while (!seen.has(current)) {
        seen.add(current);
        if (current === resolve(home)) break;
        dirs.push(current);
        if (existsSync(join(current, '.git'))) break;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return dirs;
}

export function loadClaudeInventory(cwd: string): SessionInventoryPatch {
    let machine: Record<string, unknown> = {};
    try {
        machine = readMachineClaudeSettings();
    } catch (error) {
        logger.debug('[session-inventory] Claude settings unreadable', error);
    }
    const hookSettings = [
        buildHookSettings(machine, 'hook-forwarder'),
        buildHookSettings(machine, 'hook-forwarder', undefined, true),
        buildHookSettings(machine, 'hook-forwarder', undefined, false, true),
    ];
    const claudeJson = join(homedir(), '.claude.json');
    const claudeText = readTextFile(claudeJson, { allowSymlink: true }) ?? '';
    let claudeParsed: unknown = null;
    if (claudeText) {
        try {
            claudeParsed = JSON.parse(claudeText) as unknown;
        } catch {
            claudeParsed = null;
        }
    }
    const claudeOrigin = claudeText ? { file: claudeJson, cwd, text: claudeText } : undefined;
    const settingsDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
    const userSettings = join(settingsDir, 'settings.json');
    const projectSettings = [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
    const servers = [
        { name: 'hapi', source: 'injected' as const },
        ...mcpServersFromClaudeJson(claudeParsed, cwd).map((server) => ({ ...server, ...fileLocation(claudeOrigin, server.name) })),
        ...projectMcpPaths(cwd).flatMap((path) => jsonServersFromFile(path, cwd, 'project')),
        ...jsonServersFromFile(userSettings, cwd, 'user'),
        ...projectSettings.flatMap((path) => jsonServersFromFile(path, cwd, 'project')),
    ];
    const injectedHooks = hookSettings.flatMap((settings) => hooksFromClaudeSettings(settings)).filter((hook) => hook.source === 'injected');
    const fileHooks = [
        ...hooksFromFile(userSettings, cwd, 'user'),
        ...projectSettings.flatMap((path) => hooksFromFile(path, cwd, 'project')),
    ];
    return {
        mcp: { kind: 'servers', servers: dedupeServers(servers) },
        hooks: { availability: 'listed', items: dedupeHooks([...injectedHooks, ...fileHooks]) },
    };
}

export function loadCodexInventory(includeInjectedHooks: boolean, cwd = ''): SessionInventoryPatch {
    const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    const path = join(home, 'config.toml');
    const text = readTextFile(path, { allowSymlink: true }) ?? '';
    const parsed = parseCodexConfigInventory(text, cwd || undefined);
    const origin = text && cwd ? { file: path, cwd, text } : undefined;
    const withFile = <T extends { filePath?: string; line?: number }>(item: T, key: string): T => {
        if (!origin || item.filePath) return item;
        const located = fileLocation(origin, key);
        return { ...item, ...located, ...(item.line ? { line: item.line } : {}) };
    };
    return {
        mcp: {
            kind: 'servers',
            servers: dedupeServers([
                { name: 'hapi', source: 'injected' },
                ...parsed.servers.map((server) => withFile(server, server.name)),
            ]),
        },
        hooks: {
            availability: 'listed',
            items: dedupeHooks([
                ...(includeInjectedHooks ? codexInjectedHooks() : []),
                ...parsed.hooks.map((hook) => withFile(hook, hook.event)),
            ]),
        },
    };
}

export function cursorInventory(servers: readonly { name: string; source: 'injected' | 'user' }[]): SessionInventoryPatch {
    return {
        mcp: {
            kind: 'servers',
            servers: dedupeServers(servers.map((server) => ({
                name: server.name,
                source: server.source,
            }))),
        },
        hooks: { availability: 'none', items: [] },
    };
}

export function codexSkillSource(scope: string | undefined): 'user' | 'project' | 'plugin' | 'system' | undefined {
    if (scope === 'user' || scope === 'project' || scope === 'plugin' || scope === 'system') return scope;
    return undefined;
}

const CURSOR_OVERLAY_PID_ENV = 'HAPI_MCP_OVERLAY_PID';

export function cursorServersFromMcpJson(value: unknown, sessionId?: string): SessionInventoryMcpServer[] {
    const servers = asRecord(asRecord(value).mcpServers);
    const items: SessionInventoryMcpServer[] = [];
    for (const [name, entry] of Object.entries(servers)) {
        if (!isSafeInventoryName(name)) continue;
        const env = asRecord(asRecord(entry).env);
        const stamped = typeof env[CURSOR_OVERLAY_PID_ENV] === 'string' && String(env[CURSOR_OVERLAY_PID_ENV]).trim() !== '';
        const injected = (sessionId !== undefined && name === `hapi-${sessionId}`) || (name.startsWith('hapi-') && stamped);
        items.push({ name: name.trim(), source: injected ? 'injected' : 'user' });
    }
    return dedupeServers(items);
}

function loadCursorInventory(sessionId: string | undefined, cwd: string): LiveSessionConfig {
    const path = join(homedir(), '.cursor', 'mcp.json');
    const text = readTextFile(path, { allowSymlink: true }) ?? '';
    let parsed: unknown = null;
    if (text) {
        try {
            parsed = JSON.parse(text) as unknown;
        } catch {
            parsed = null;
        }
    }
    const origin = text ? { file: path, cwd, text } : undefined;
    return {
        mcp: {
            kind: 'servers',
            servers: cursorServersFromMcpJson(parsed, sessionId).map((server) => (
                server.source === 'injected' ? server : { ...server, ...fileLocation(origin, server.name) }
            )),
        },
        hooks: { availability: 'none', items: [] },
    };
}

function flavorInventory(input: {
    flavor: string;
    cwd: string;
    tools?: readonly string[];
    sessionId?: string;
    startingMode?: string | null;
}): LiveSessionConfig {
    switch (input.flavor) {
        case 'claude':
            return loadClaudeInventory(input.cwd);
        case 'codex':
            return loadCodexInventory(input.startingMode === 'local', input.cwd);
        case 'cursor':
            return loadCursorInventory(input.sessionId, input.cwd);
        case 'omp':
            return loadOmpInventory(input.cwd);
        case 'copilot':
        case 'grok':
        case 'kimi':
            return bridgeInventory(input.flavor) ?? {};
        case 'opencode':
            return {
                ...(bridgeInventory('opencode') ?? {}),
                ...(input.startingMode === 'local' ? OPENCODE_HOOK_INVENTORY : {}),
            };
        case 'pi':
        case 'dsh':
        case 'agy':
            return EMPTY_FLAVOR_INVENTORY;
        default:
            return {};
    }
}


const PROJECT_AGENT_DIRS = ['.omp/agents', '.claude/agents', '.codex/agents', '.gemini/agents'] as const;

function unquoteAgentValue(value: string): string {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function agentFrontmatter(text: string): { name?: string; description?: string; line?: number } {
    if (!text.startsWith('---')) return {};
    const end = text.indexOf('\n---', 3);
    if (end < 0) return {};
    const lines = text.slice(0, end).split(/\r?\n/);
    let name: string | undefined;
    let description: string | undefined;
    let line: number | undefined;
    for (let index = 0; index < lines.length; index++) {
        const nameMatch = /^name:\s*(.+)$/.exec(lines[index]);
        const descriptionMatch = /^description:\s*(.+)$/.exec(lines[index]);
        if (nameMatch && !name) {
            name = unquoteAgentValue(nameMatch[1]);
            line = index + 1;
        }
        if (descriptionMatch && !description) description = unquoteAgentValue(descriptionMatch[1]);
    }
    return { name, description, line };
}

function agentsFromDirectory(dir: string, cwd: string, source: SessionInventorySource): SessionInventoryAgent[] {
    let names: string[] = [];
    try {
        names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
    } catch {
        return [];
    }
    const items: SessionInventoryAgent[] = [];
    for (const fileName of names) {
        const file = join(dir, fileName);
        const text = readTextFile(file);
        if (!text) continue;
        const meta = agentFrontmatter(text);
        const name = (meta.name || fileName.replace(/\.md$/, '')).trim();
        if (!isSafeInventoryName(name)) continue;
        const description = redactStoredText(meta.description, 500);
        const filePath = listedConfigFilePath(file, cwd);
        items.push({
            name,
            source,
            ...(description ? { description } : {}),
            ...(filePath ? { filePath } : {}),
            ...(filePath && meta.line ? { line: meta.line } : {}),
        });
    }
    return items;
}

function projectAgentDirectories(cwd: string, home = homedir()): string[] {
    const dirs: string[] = [];
    let current = resolve(cwd);
    const seen = new Set<string>();
    while (!seen.has(current)) {
        seen.add(current);
        if (current === resolve(home)) break;
        for (const relative of PROJECT_AGENT_DIRS) dirs.push(join(current, relative));
        if (existsSync(join(current, '.git'))) break;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return dirs;
}

function userAgentDirectories(): string[] {
    const home = homedir();
    const ompHome = process.env.PI_CODING_AGENT_DIR?.trim() || join(home, '.omp', 'agent');
    const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
    return [
        join(ompHome, 'agents'),
        join(claudeHome, 'agents'),
        join(home, '.codex', 'agents'),
        join(home, '.gemini', 'agents'),
    ];
}

let bundledAgentsDir: Promise<string | undefined> | undefined;

function bundledAgentCacheRoot(): string {
    const xdg = process.env.XDG_CACHE_HOME?.trim();
    return xdg ? join(xdg, 'hapi', 'omp-bundled-agents') : join(homedir(), '.hapi', 'omp-bundled-agents');
}

function spawnText(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string }>();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
        child.kill();
        finish(null);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', () => undefined);
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    return promise;
}

async function loadBundledAgentDirectory(): Promise<string | undefined> {
    const version = await spawnText('omp', ['--version'], 5000);
    if (version.code !== 0) return undefined;
    const tag = version.stdout.trim().split(/\s+/)[0]?.replace(/[^\w.-]/g, '') || 'unknown';
    const dir = join(bundledAgentCacheRoot(), tag);
    if (existsSync(join(dir, 'scout.md'))) return dir;
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        return undefined;
    }
    const unpacked = await spawnText('omp', ['agents', 'unpack', '--dir', dir, '--force'], 20000);
    return unpacked.code === 0 ? dir : undefined;
}

async function bundledAgentDirectory(): Promise<string | undefined> {
    const override = process.env.HAPI_OMP_BUNDLED_AGENTS?.trim();
    if (override === '0') return undefined;
    if (override) return override;
    if (process.env.VITEST) return undefined;
    if (!bundledAgentsDir) {
        const pending = loadBundledAgentDirectory().then((dir) => {
            if (!dir) bundledAgentsDir = undefined
            return dir
        })
        bundledAgentsDir = pending
    }
    return bundledAgentsDir
}

/** Directories omp 18.12.6 actually scans: ~/.omp/agent/agents (PI_CODING_AGENT_DIR first), project .omp/agents, plus the same agents/ folder under .claude, .codex, and .gemini. Bundled agents are embedded in the omp binary and materialized with `omp agents unpack`. */
export async function listSessionAgents(cwd: string): Promise<SessionInventoryAgent[]> {
    const byName = new Map<string, SessionInventoryAgent>();
    const add = (agent: SessionInventoryAgent) => {
        if (!byName.has(agent.name)) byName.set(agent.name, agent);
    };
    for (const dir of projectAgentDirectories(cwd)) {
        for (const agent of agentsFromDirectory(dir, cwd, 'project')) add(agent);
    }
    for (const dir of userAgentDirectories()) {
        for (const agent of agentsFromDirectory(dir, cwd, 'user')) add(agent);
    }
    const bundled = await bundledAgentDirectory();
    if (bundled) {
        for (const agent of agentsFromDirectory(bundled, cwd, 'system')) add(agent);
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 200);
}

export async function readLiveSessionConfig(input: {
    flavor?: string | null;
    cwd: string;
    tools?: readonly string[];
    sessionId?: string;
    startingMode?: string | null;
    skills?: LiveSessionConfig['skills'];
    promptLive?: SessionPromptLive;
    fresh?: boolean;
    check?: string;
}): Promise<LiveSessionConfig> {
    const flavor = (input.flavor ?? '').trim().toLowerCase();
    const sections = flavorInventory({ ...input, flavor });
    const promptLive = { ...getSessionPromptLive(input.sessionId), ...input.promptLive };
    const mcp = sections.mcp
        ? {
            kind: 'servers' as const,
            servers: flavor === 'omp'
                ? await withOmpCheckedLoadState(sections.mcp.servers, input.tools, input.cwd, { fresh: input.fresh, check: input.check })
                : withMcpLoadState(sections.mcp.servers, input.tools),
        }
        : undefined;
    const diskSkills = await listInventorySkills(input.cwd, { flavor: flavor || undefined });
    const filePathByName = new Map(diskSkills.flatMap((skill) => skill.filePath ? [[skill.name, skill.filePath] as const] : []));
    const disabledSkills = new Set(diskSkills.filter((skill) => skill.enabled === false).map((skill) => skill.name));
    const listed = input.skills ?? inventorySkills(diskSkills);
    const skills = {
        ...listed,
        items: listed.items.map((item) => {
            const filePath = item.filePath ?? filePathByName.get(item.name);
            return {
                ...item,
                ...(disabledSkills.has(item.name) ? { enabled: false as const } : {}),
                ...(filePath ? { filePath } : {}),
            };
        }),
    };
    const prompts = collectSessionPrompts({
        flavor,
        cwd: input.cwd,
        startingMode: input.startingMode,
        sessionId: input.sessionId,
        promptLive,
    }).prompts;
    const agents = { items: await listSessionAgents(input.cwd) };
    return { ...sections, ...(mcp ? { mcp } : {}), agents, skills, prompts };
}

export async function listedSessionConfigRealpaths(input: {
    flavor?: string | null;
    cwd: string;
    tools?: readonly string[];
    sessionId?: string;
    startingMode?: string | null;
    skills?: LiveSessionConfig['skills'];
    promptLive?: SessionPromptLive;
}): Promise<Set<string>> {
    const config = await readLiveSessionConfig(input);
    const paths = [
        ...(config.mcp?.servers ?? []).flatMap((server) => server.filePath ? [server.filePath] : []),
        ...(config.hooks?.items ?? []).flatMap((hook) => [hook.filePath, hook.scriptPath].filter((path): path is string => Boolean(path))),
        ...(config.skills?.items ?? []).flatMap((skill) => skill.filePath ? [skill.filePath] : []),
        ...(config.agents?.items ?? []).flatMap((agent) => agent.filePath ? [agent.filePath] : []),
        ...(config.prompts?.system?.items ?? []).flatMap((item) => item.filePath ? [item.filePath] : []),
        ...(config.prompts?.user?.items ?? []).flatMap((item) => item.filePath ? [item.filePath] : []),
    ];
    const allowed = new Set<string>();
    for (const filePath of paths) {
        const real = tryRealpath(resolve(input.cwd, filePath));
        if (real) allowed.add(real);
    }
    return allowed;
}
