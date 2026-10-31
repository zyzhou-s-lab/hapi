import { existsSync } from 'node:fs';
import { access, lstat, open, readdir, readFile, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { parse as parseYaml } from 'yaml';
import { listedConfigFilePath } from './configFilePath';
export interface SkillSummary {
    name: string;
    description?: string;
    source?: 'user' | 'project' | 'plugin' | 'system';
}

export interface ResolvedSkill extends SkillSummary {
    body: string;
}

export const MAX_SKILL_FILE_BYTES = 128 * 1024;

export interface ListSkillsRequest {
    flavor?: string;
}

export interface ListSkillsResponse {
    success: boolean;
    skills?: SkillSummary[];
    error?: string;
}

type InstalledPlugin = {
    installPath?: string;
    installedAt?: string;
    lastUpdated?: string;
};

type InstalledPluginsFile = {
    plugins?: Record<string, InstalledPlugin[]>;
};

type DiscoveredSkill = ResolvedSkill & {
    fileSize: number;
    filePath: string;
    enabled: boolean;
};
export function getHomeDirectory(): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

function normalizeFlavor(flavor?: string): string {
    return (flavor ?? 'claude').trim().toLowerCase();
}

function getAgentConfigDir(flavor?: string): string {
    const normalizedFlavor = normalizeFlavor(flavor);
    switch (normalizedFlavor) {
        case 'claude':
            return process.env.CLAUDE_CONFIG_DIR || join(getHomeDirectory(), '.claude');
        case 'codex':
            return process.env.CODEX_HOME || join(getHomeDirectory(), '.codex');
        case 'grok':
            return process.env.GROK_HOME || join(getHomeDirectory(), '.grok');
        default:
            return join(getHomeDirectory(), `.${normalizedFlavor}`);
    }
}

export function getUserSkillsRoots(flavor?: string): string[] {
    const home = getHomeDirectory();
    const roots = [join(home, '.agents', 'skills')];
    switch (normalizeFlavor(flavor)) {
        case 'claude':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
        case 'codex':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
        case 'grok':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
        case 'copilot':
            roots.push(join(getAgentConfigDir(flavor), 'skills'));
            break;
    }
    return roots;
}

function getAdminSkillsRoot(): string {
    return join('/etc', 'codex', 'skills');
}

function getProjectSkillsRoots(directory: string, flavor?: string): string[] {
    const roots = [join(directory, '.agents', 'skills')];
    switch (normalizeFlavor(flavor)) {
        case 'claude':
            roots.push(join(directory, '.claude', 'skills'));
            break;
        case 'codex':
            roots.push(join(directory, '.codex', 'skills'));
            break;
        case 'grok':
            roots.push(join(directory, '.grok', 'skills'));
            break;
        case 'copilot':
            roots.push(join(directory, '.copilot', 'skills'));
            roots.push(join(directory, '.github', 'skills'));
            break;
    }
    return roots;
}
export type SkillWriteRoot = { root: string, anchor?: string }

/** Roots a toggle may write for this skill's own source. User and project roots stay separate. */
export function skillWriteRoots(workingDirectory: string | undefined, source: 'user' | 'project'): SkillWriteRoot[] {
    if (source === 'user') return userSkillWriteRoots().map((root) => ({ root }));
    return projectWriteRoots(workingDirectory);
}

function userSkillWriteRoots(): string[] {
    const home = getHomeDirectory();
    const ompHome = process.env.PI_CODING_AGENT_DIR?.trim() || join(home, '.omp', 'agent');
    return [
        join(home, '.agents', 'skills'),
        join(ompHome, 'skills'),
        join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'skills'),
        join(process.env.CODEX_HOME?.trim() || join(home, '.codex'), 'skills'),
        join(process.env.GROK_HOME?.trim() || join(home, '.grok'), 'skills'),
        join(home, '.copilot', 'skills'),
    ];
}

function projectWriteRoots(workingDirectory: string | undefined): SkillWriteRoot[] {
    if (!workingDirectory) return [];
    const start = resolve(workingDirectory);
    const directories = [start];
    let current = start;
    while (!existsSync(join(current, '.git'))) {
        const parent = dirname(current);
        if (parent === current) return projectSkillRoots(start);
        current = parent;
        directories.push(current);
    }
    return directories.flatMap(projectSkillRoots);
}

function projectSkillRoots(directory: string): SkillWriteRoot[] {
    return [
        join(directory, '.agents', 'skills'),
        join(directory, '.omp', 'skills'),
        join(directory, '.omp', 'agent', 'skills'),
        join(directory, '.claude', 'skills'),
        join(directory, '.codex', 'skills'),
        join(directory, '.grok', 'skills'),
        join(directory, '.copilot', 'skills'),
        join(directory, '.github', 'skills'),
    ].map((root) => ({ root, anchor: directory }));
}


async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function isDirectory(path: string): Promise<boolean> {
    return await stat(path).then((info) => info.isDirectory()).catch(() => false);
}

async function listProjectSkillsRoots(workingDirectory?: string, flavor?: string): Promise<string[]> {
    if (!workingDirectory) {
        return [];
    }

    const resolvedWorkingDirectory = resolve(workingDirectory);
    const directories = [resolvedWorkingDirectory];
    let currentDirectory = resolvedWorkingDirectory;

    while (true) {
        if (await pathExists(join(currentDirectory, '.git'))) {
            return directories.flatMap((directory) => getProjectSkillsRoots(directory, flavor));
        }

        const parentDirectory = dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            return getProjectSkillsRoots(resolvedWorkingDirectory, flavor);
        }

        currentDirectory = parentDirectory;
        directories.push(currentDirectory);
    }
}

function parseFrontmatter(fileContent: string): { frontmatter?: Record<string, unknown>; body: string } {
    const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { body: fileContent.trim() };
    }

    const yamlContent = match[1];
    const body = match[2].trim();
    try {
        const parsed = parseYaml(yamlContent) as Record<string, unknown> | null;
        return { frontmatter: parsed ?? undefined, body };
    } catch {
        return { body: fileContent.trim() };
    }
}

function extractSkillSummary(skillDir: string, fileContent: string): SkillSummary | null {
    const parsed = parseFrontmatter(fileContent);
    const nameFromFrontmatter = typeof parsed.frontmatter?.name === 'string' ? parsed.frontmatter.name.trim() : '';
    const name = nameFromFrontmatter || basename(skillDir);
    if (!name) {
        return null;
    }

    const description = typeof parsed.frontmatter?.description === 'string'
        ? parsed.frontmatter.description.trim()
        : undefined;

    return { name, description };
}

async function skillDirAllowed(entryPath: string, skillsRoot: string): Promise<boolean> {
    try {
        const linked = await lstat(entryPath);
        if (linked.isSymbolicLink()) {
            const real = await realpath(entryPath);
            const root = await realpath(skillsRoot);
            const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
            if (real !== root && !real.startsWith(prefix)) return false;
        }
    } catch {
        return false;
    }
    return isDirectory(entryPath);
}

async function listTopLevelSkillDirs(skillsRoot: string, options: { includeCodexSystem?: boolean } = {}): Promise<string[]> {
    try {
        const entries = await readdir(skillsRoot);
        const result: string[] = [];

        for (const entry of entries) {
            const entryPath = join(skillsRoot, entry);
            if (!await skillDirAllowed(entryPath, skillsRoot)) {
                continue;
            }

            if (entry.startsWith('.')) {
                if (options.includeCodexSystem && entry === '.system') {
                    const systemEntries = await readdir(entryPath).catch(() => []);
                    for (const systemEntry of systemEntries) {
                        const systemEntryPath = join(entryPath, systemEntry);
                        if (!systemEntry.startsWith('.') && await skillDirAllowed(systemEntryPath, skillsRoot)) {
                            result.push(systemEntryPath);
                        }
                    }
                }
                continue;
            }

            result.push(entryPath);
        }

        return result;
    } catch {
        return [];
    }
}

async function readSkillFile(filePath: string): Promise<{ content: string; fileSize: number } | null> {
    try {
        const file = await open(filePath, 'r');
        try {
            const info = await file.stat();
            if (!info.isFile()) {
                return null;
            }

            const bytesToRead = Math.min(info.size, MAX_SKILL_FILE_BYTES + 1);
            const buffer = Buffer.alloc(bytesToRead);
            const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
            return {
                content: buffer.subarray(0, bytesRead).toString('utf-8'),
                fileSize: info.size
            };
        } finally {
            await file.close();
        }
    } catch {
        return null;
    }
}

async function readSkillsFromDirs(skillDirs: string[], source: NonNullable<SkillSummary['source']>): Promise<DiscoveredSkill[]> {
    const skills = await Promise.all(skillDirs.map(async (dir): Promise<DiscoveredSkill | null> => {
        const filePath = join(dir, 'SKILL.md');
        const skillFile = await readSkillFile(filePath);
        if (!skillFile) {
            return null;
        }

        const summary = extractSkillSummary(dir, skillFile.content);
        if (!summary) {
            return null;
        }

        const parsed = parseFrontmatter(skillFile.content);
        return {
            ...summary,
            source: dir.split(sep).includes('.system') ? 'system' : source,
            body: parsed.body,
            fileSize: skillFile.fileSize,
            filePath,
            enabled: parsed.frontmatter?.disabled !== true,
        };
    }));

    return skills.filter((skill): skill is DiscoveredSkill => skill !== null);
}

function shouldIncludeCodexSystem(root: string, flavor: string): boolean {
    if (flavor !== 'codex') {
        return false;
    }

    return root.endsWith(join('.codex', 'skills'))
        || root === join(getAgentConfigDir('codex'), 'skills');
}

async function listPluginCacheSkillsRoots(flavor?: string): Promise<string[]> {
    const installedPath = join(getAgentConfigDir(flavor), 'plugins', 'installed_plugins.json');
    let installed: InstalledPluginsFile;

    try {
        installed = JSON.parse(await readFile(installedPath, 'utf-8')) as InstalledPluginsFile;
    } catch {
        return [];
    }

    const getInstallTime = (installation: InstalledPlugin): number => {
        const lastUpdated = Date.parse(installation.lastUpdated ?? '');
        if (Number.isFinite(lastUpdated)) return lastUpdated;
        const installedAt = Date.parse(installation.installedAt ?? '');
        return Number.isFinite(installedAt) ? installedAt : 0;
    };

    return Object.values(installed.plugins ?? {})
        .filter((installations): installations is InstalledPlugin[] => Array.isArray(installations))
        .map((installations) => [...installations]
            .sort((a, b) => getInstallTime(b) - getInstallTime(a))[0]?.installPath)
        .filter((installPath): installPath is string => typeof installPath === 'string' && installPath.length > 0)
        .map((installPath) => join(installPath, 'skills'));
}

async function discoverSkills(workingDirectory?: string, options: { flavor?: string } = {}): Promise<DiscoveredSkill[]> {
    const flavor = normalizeFlavor(options.flavor);
    const projectRoots = await listProjectSkillsRoots(workingDirectory, flavor);
    const userRoots = getUserSkillsRoots(flavor);
    const pluginRoots = await listPluginCacheSkillsRoots(flavor);
    const adminRoot = getAdminSkillsRoot();
    const includeAdminRoots = flavor === 'codex';
    const [projectSkillDirs, userSkillDirs, pluginSkillDirs, adminSkillDirs] = await Promise.all([
        Promise.all(projectRoots.map(async (root) => await listTopLevelSkillDirs(root, { includeCodexSystem: shouldIncludeCodexSystem(root, flavor) }))).then((dirs) => dirs.flat()),
        Promise.all(userRoots.map(async (root) => await listTopLevelSkillDirs(root, { includeCodexSystem: shouldIncludeCodexSystem(root, flavor) }))).then((dirs) => dirs.flat()),
        Promise.all(pluginRoots.map(async (root) => await listTopLevelSkillDirs(root, { includeCodexSystem: false }))).then((dirs) => dirs.flat()),
        includeAdminRoots ? listTopLevelSkillDirs(adminRoot, { includeCodexSystem: true }) : [],
    ]);

    const [projectSkills, userSkills, pluginSkills, adminSkills] = await Promise.all([
        readSkillsFromDirs(projectSkillDirs, 'project'),
        readSkillsFromDirs(userSkillDirs, 'user'),
        readSkillsFromDirs(pluginSkillDirs, 'plugin'),
        readSkillsFromDirs(adminSkillDirs, 'system'),
    ]);

    const dedupedSkills = new Map<string, DiscoveredSkill>();
    for (const skill of [
        ...projectSkills,
        ...userSkills,
        ...pluginSkills,
        ...adminSkills,
    ]) {
        if (!dedupedSkills.has(skill.name)) {
            dedupedSkills.set(skill.name, skill);
        }
    }

    return [...dedupedSkills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listInventorySkills(workingDirectory?: string, options: { flavor?: string } = {}): Promise<Array<SkillSummary & { enabled?: boolean; filePath?: string }>> {
    const skills = await discoverSkills(workingDirectory, options);
    return skills.map(({ name, description, source, enabled, filePath }) => {
        const listed = workingDirectory ? listedConfigFilePath(filePath, workingDirectory) : undefined
        return {
            name,
            ...(description ? { description } : {}),
            ...(source ? { source } : {}),
            ...(enabled ? {} : { enabled: false }),
            ...(listed ? { filePath: listed } : {}),
        }
    });
}

export async function findSkill(
    name: string,
    workingDirectory?: string,
    options: { flavor?: string } = {}
): Promise<{
    name: string;
    source?: SkillSummary['source'];
    filePath: string;
    enabled: boolean;
    markdown: string;
    truncated: boolean;
} | null> {
    const skillName = validateSkillName(name);
    const skills = await discoverSkills(workingDirectory, options);
    const skill = skills.find((candidate) => candidate.name === skillName);
    if (!skill) return null;
    const file = await readSkillFile(skill.filePath);
    if (!file) return null;
    return {
        name: skill.name,
        source: skill.source,
        filePath: skill.filePath,
        enabled: skill.enabled,
        markdown: file.content.slice(0, MAX_SKILL_FILE_BYTES),
        truncated: file.fileSize > MAX_SKILL_FILE_BYTES,
    };
}

export async function listSkills(workingDirectory?: string, options: { flavor?: string } = {}): Promise<SkillSummary[]> {
    const skills = await discoverSkills(workingDirectory, options);
    return skills.map(({ name, description, source }) => ({ name, description, ...(source ? { source } : {}) }));
}
function validateSkillName(name: string): string {
    const trimmed = name.trim();
    if (
        !trimmed
        || trimmed.length > 128
        || trimmed === '.'
        || trimmed === '..'
        || trimmed.includes('/')
        || trimmed.includes('\\')
        || trimmed.includes('\0')
    ) {
        throw new Error('Invalid skill name');
    }
    return trimmed;
}

export async function resolveSkill(
    name: string,
    workingDirectory?: string,
    options: { flavor?: string } = {}
): Promise<ResolvedSkill | null> {
    const skillName = validateSkillName(name);
    const skills = await discoverSkills(workingDirectory, options);
    const skill = skills.find((candidate) => candidate.name === skillName);
    if (!skill) {
        return null;
    }
    if (skill.fileSize > MAX_SKILL_FILE_BYTES) {
        throw new Error(`Skill is too large to load (maximum ${MAX_SKILL_FILE_BYTES} bytes)`);
    }
    return {
        name: skill.name,
        description: skill.description,
        body: skill.body
    };
}
