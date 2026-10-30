import { useSyncExternalStore } from 'react'

/**
 * 会话标签：打开过的会话按打开顺序排成一排，顺序只由用户决定（打开、拖动、固定、关闭），
 * 不随会话活跃度上浮下沉。按「hub + 账号」分别存在 localStorage。
 * 每个工作目录（与侧栏分组同一把钥匙）单独一组；切走再回来，顺序和固定状态还在。
 *
 * 纯函数负责规则（便于单测），store 只负责持久化与订阅。
 */
export type SessionTab = {
    id: string
    pinned: boolean
    /** 最近一次被切到前台的时间，用于超出上限时淘汰最久没看的那个。 */
    activatedAt: number
}

/** 一个目录里的标签条。开关、固定、拖动都作用在这一条上。 */
export type SessionTabsState = { tabs: SessionTab[] }

/** 全部目录的标签。总览页用 activeDirectoryKey 决定显示哪一组。 */
export type SessionTabGroups = {
    activeDirectoryKey: string | null
    groups: Record<string, SessionTab[]>
}

/**
 * 每个目录各自的上限，打开和从 localStorage 读回共用。
 * 不是全局 12 个：标签条一次只显示一个目录，全局名额会在切目录时悄悄关掉另一组。
 * 固定标签计入这个目录的上限，不是额外名额；它们只是不会被自动淘汰。
 * 这一目录 12 个全是固定标签时，再打开新会话不会变成第 13 个。
 */
export const MAX_SESSION_TABS = 12

/**
 * 升级前的扁平列表还没有目录。先放在这里，等完整会话列表到了再拆进各自的目录。
 * 真实目录钥匙总是 `machine::path`，不会是空串。
 */
export const LEGACY_DIRECTORY_KEY = ''

const EMPTY_LIST: SessionTabsState = { tabs: [] }
const EMPTY: SessionTabGroups = { activeDirectoryKey: null, groups: {} }

function normalizeOrder(tabs: SessionTab[]): SessionTab[] {
    return [...tabs.filter(tab => tab.pinned), ...tabs.filter(tab => !tab.pinned)]
}

/** 打开（或切到）一个会话：已在标签里就只更新激活时间，不挪位置；新会话追加到末尾。 */
export function openTab(state: SessionTabsState, id: string, now: number): SessionTabsState {
    const existing = state.tabs.find(tab => tab.id === id)
    if (existing) {
        return { tabs: state.tabs.map(tab => (tab.id === id ? { ...tab, activatedAt: now } : tab)) }
    }
    if (state.tabs.length >= MAX_SESSION_TABS && state.tabs.every(tab => tab.pinned)) return state
    let tabs = [...state.tabs, { id, pinned: false, activatedAt: now }]
    while (tabs.length > MAX_SESSION_TABS) {
        const victim = tabs
            .filter(tab => !tab.pinned && tab.id !== id)
            .sort((a, b) => a.activatedAt - b.activatedAt)[0]
        if (!victim) return state
        tabs = tabs.filter(tab => tab.id !== victim.id)
    }
    return { tabs }
}

/** 关掉一个标签；返回关掉之后应该切到的标签（右边优先，没有就左边）。 */
export function closeTab(state: SessionTabsState, id: string): { state: SessionTabsState; neighbor: string | null } {
    const index = state.tabs.findIndex(tab => tab.id === id)
    if (index < 0) return { state, neighbor: null }
    const tabs = state.tabs.filter(tab => tab.id !== id)
    const neighbor = tabs[index]?.id ?? tabs[index - 1]?.id ?? null
    return { state: { tabs }, neighbor }
}

export function closeOtherTabs(state: SessionTabsState, keepId: string): SessionTabsState {
    return { tabs: state.tabs.filter(tab => tab.pinned || tab.id === keepId) }
}

export function closeTabsToRight(state: SessionTabsState, id: string): SessionTabsState {
    const index = state.tabs.findIndex(tab => tab.id === id)
    if (index < 0) return state
    return { tabs: state.tabs.filter((tab, i) => i <= index || tab.pinned) }
}

/** 固定的标签排在最前、不会被自动淘汰。 */
export function togglePinTab(state: SessionTabsState, id: string): SessionTabsState {
    return { tabs: normalizeOrder(state.tabs.map(tab => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab))) }
}

/** 拖动排序：把 fromId 放到 toId 的位置。固定区与非固定区之间不能互相拖。 */
export function moveTab(state: SessionTabsState, fromId: string, toId: string): SessionTabsState {
    if (fromId === toId) return state
    const from = state.tabs.findIndex(tab => tab.id === fromId)
    const to = state.tabs.findIndex(tab => tab.id === toId)
    if (from < 0 || to < 0 || state.tabs[from]!.pinned !== state.tabs[to]!.pinned) return state
    const tabs = [...state.tabs]
    const [moved] = tabs.splice(from, 1)
    tabs.splice(to, 0, moved!)
    return { tabs }
}

/**
 * Ids present in a previous complete list and missing from the next one.
 * `previous === null` means this window has not seen a full list yet, so nothing is confirmed deleted.
 */
export function confirmedDeletedIds(previous: ReadonlySet<string> | null, current: ReadonlySet<string>): ReadonlySet<string> {
    if (!previous) return new Set()
    const deleted = new Set<string>()
    for (const id of previous) {
        if (!current.has(id)) deleted.add(id)
    }
    return deleted
}

/**
 * 本窗口还没见过完整列表时：已经不在列表里的标签就是被删掉的。
 * 本窗口刚打开、列表还没跟上的 id 留着，避免新建会话被清掉。
 */
export function tabsMissingFromFirstList(
    tabIds: readonly string[],
    current: ReadonlySet<string>,
    openedThisWindow: ReadonlySet<string>,
): Set<string> {
    const deleted = new Set<string>()
    for (const id of tabIds) {
        if (!current.has(id) && !openedThisWindow.has(id)) deleted.add(id)
    }
    return deleted
}

export function allTabIds(state: SessionTabGroups): string[] {
    const ids: string[] = []
    for (const tabs of Object.values(state.groups)) {
        for (const tab of tabs) ids.push(tab.id)
    }
    return ids
}

function findDirectoryKey(state: SessionTabGroups, id: string): string | null {
    for (const [key, tabs] of Object.entries(state.groups)) {
        if (tabs.some(tab => tab.id === id)) return key
    }
    return null
}

function commitGroup(state: SessionTabGroups, directoryKey: string, tabs: SessionTab[], activate: boolean): SessionTabGroups {
    const sameTabs = state.groups[directoryKey] === tabs
    const sameActive = !activate || state.activeDirectoryKey === directoryKey
    if (sameTabs && sameActive) return state
    const groups = { ...state.groups }
    if (tabs.length === 0) delete groups[directoryKey]
    else groups[directoryKey] = tabs
    return {
        activeDirectoryKey: activate ? directoryKey : state.activeDirectoryKey,
        groups,
    }
}

/** 追加一个标签。目录已满且全部固定时返回 null，调用方不要改原组。 */
function insertTab(tabs: SessionTab[], tab: SessionTab): SessionTab[] | null {
    if (tabs.length >= MAX_SESSION_TABS && tabs.every(item => item.pinned)) return null
    let next = [...tabs, tab]
    while (next.length > MAX_SESSION_TABS) {
        const victim = next
            .filter(item => !item.pinned && item.id !== tab.id)
            .sort((a, b) => a.activatedAt - b.activatedAt)[0]
        if (!victim) return null
        next = next.filter(item => item.id !== victim.id)
    }
    return normalizeOrder(next)
}

export type OpenInDirectoryResult = {
    state: SessionTabGroups
    /** 该目录 12 个都已固定，新会话没有放进去。 */
    rejected: 'pinned-full' | null
}

/** 在指定目录打开标签，并把总览要记住的目录设成这一个。已在别的目录里就搬过来，固定状态保留。 */
export function openTabInDirectory(state: SessionTabGroups, directoryKey: string, id: string, now: number): OpenInDirectoryResult {
    if (!directoryKey) return { state, rejected: null }
    const fromKey = findDirectoryKey(state, id)
    if (fromKey === directoryKey) {
        const nextTabs = openTab({ tabs: state.groups[directoryKey]! }, id, now).tabs
        return { state: commitGroup(state, directoryKey, nextTabs, true), rejected: null }
    }
    const existing = fromKey ? state.groups[fromKey]!.find(tab => tab.id === id)! : null
    const dest = state.groups[directoryKey] ?? []
    const inserted = insertTab(dest, existing
        ? { ...existing, activatedAt: now }
        : { id, pinned: false, activatedAt: now })
    if (!inserted) {
        const next = state.activeDirectoryKey === directoryKey ? state : { ...state, activeDirectoryKey: directoryKey }
        return { state: next, rejected: 'pinned-full' }
    }
    const groups = { ...state.groups }
    if (fromKey) {
        const source = groups[fromKey]!.filter(tab => tab.id !== id)
        if (source.length === 0) delete groups[fromKey]
        else groups[fromKey] = source
    }
    groups[directoryKey] = inserted
    return { state: { activeDirectoryKey: directoryKey, groups }, rejected: null }
}

export function applyToGroup(
    state: SessionTabGroups,
    directoryKey: string | null,
    update: (list: SessionTabsState) => SessionTabsState,
): SessionTabGroups {
    if (!directoryKey) return state
    const currentTabs = state.groups[directoryKey]
    const current: SessionTabsState = currentTabs ? { tabs: currentTabs } : EMPTY_LIST
    const next = update(current)
    if (next === current) return state
    return commitGroup(state, directoryKey, next.tabs, false)
}

export function closeTabInDirectory(
    state: SessionTabGroups,
    directoryKey: string | null,
    id: string,
): { state: SessionTabGroups; neighbor: string | null } {
    if (!directoryKey) return { state, neighbor: null }
    const currentTabs = state.groups[directoryKey]
    const current: SessionTabsState = currentTabs ? { tabs: currentTabs } : EMPTY_LIST
    const result = closeTab(current, id)
    if (result.state === current) return { state, neighbor: null }
    return { state: commitGroup(state, directoryKey, result.state.tabs, false), neighbor: result.neighbor }
}

/** Drop tabs whose sessions were confirmed deleted. Ids the list has not shown yet stay. */
export function pruneDeletedTabs(state: SessionTabGroups, deletedIds: ReadonlySet<string>): SessionTabGroups {
    if (deletedIds.size === 0) return state
    let changed = false
    const groups: Record<string, SessionTab[]> = {}
    for (const [key, tabs] of Object.entries(state.groups)) {
        const next = tabs.filter(tab => !deletedIds.has(tab.id))
        if (next.length !== tabs.length) changed = true
        if (next.length > 0) groups[key] = next
    }
    if (!changed) return state
    return { ...state, groups }
}

function mostRecentlyActivatedKey(state: SessionTabGroups): string | null {
    let bestKey: string | null = null
    let bestAt = -Infinity
    for (const [key, tabs] of Object.entries(state.groups)) {
        if (key === LEGACY_DIRECTORY_KEY) continue
        for (const tab of tabs) {
            if (tab.activatedAt > bestAt) {
                bestKey = key
                bestAt = tab.activatedAt
            }
        }
    }
    return bestKey
}

/**
 * 把升级前的扁平标签拆进各自的目录。列表里已经没有的会话直接丢掉。
 * 没有「上次目录」时，总览落到最近激活的那个标签所在目录。
 */
export function adoptLegacyTabs(state: SessionTabGroups, directoryById: ReadonlyMap<string, string>): SessionTabGroups {
    const legacy = state.groups[LEGACY_DIRECTORY_KEY]
    if (!legacy || legacy.length === 0) return state
    const groups = { ...state.groups }
    delete groups[LEGACY_DIRECTORY_KEY]
    let next: SessionTabGroups = { ...state, groups }
    for (const tab of legacy) {
        const directoryKey = directoryById.get(tab.id)
        if (!directoryKey) continue
        const inserted = insertTab(next.groups[directoryKey] ?? [], tab)
        if (!inserted) continue
        next = { ...next, groups: { ...next.groups, [directoryKey]: inserted } }
    }
    if (next.activeDirectoryKey == null) {
        const key = mostRecentlyActivatedKey(next)
        if (key) next = { ...next, activeDirectoryKey: key }
    }
    return next
}

/** 会话换了目录（路径变了）就把标签搬到新目录，不改激活时间，也不改总览正在看的目录。搬不进去就留在原处。 */
export function rehomeTabs(state: SessionTabGroups, directoryById: ReadonlyMap<string, string>): SessionTabGroups {
    const moves: { id: string; to: string }[] = []
    for (const [key, tabs] of Object.entries(state.groups)) {
        if (key === LEGACY_DIRECTORY_KEY) continue
        for (const tab of tabs) {
            const live = directoryById.get(tab.id)
            if (live && live !== key) moves.push({ id: tab.id, to: live })
        }
    }
    if (moves.length === 0) return state
    let next = state
    for (const move of moves) {
        const fromKey = findDirectoryKey(next, move.id)
        if (!fromKey || fromKey === move.to) continue
        const tab = next.groups[fromKey]!.find(item => item.id === move.id)!
        const inserted = insertTab(next.groups[move.to] ?? [], tab)
        if (!inserted) continue
        const groups = { ...next.groups }
        const source = groups[fromKey]!.filter(item => item.id !== move.id)
        if (source.length === 0) delete groups[fromKey]
        else groups[fromKey] = source
        groups[move.to] = inserted
        next = { ...next, groups }
    }
    return next
}

function parseTabs(value: unknown): SessionTab[] {
    if (!Array.isArray(value)) return []
    const tabs: SessionTab[] = []
    for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const tab = item as Partial<SessionTab>
        if (typeof tab.id !== 'string' || !tab.id || tabs.some(existing => existing.id === tab.id)) continue
        tabs.push({ id: tab.id, pinned: tab.pinned === true, activatedAt: typeof tab.activatedAt === 'number' ? tab.activatedAt : 0 })
    }
    return normalizeOrder(tabs).slice(0, MAX_SESSION_TABS)
}

function parse(raw: string | null): SessionTabGroups {
    try {
        const value = raw ? JSON.parse(raw) as { version?: unknown; tabs?: unknown; groups?: unknown; activeDirectoryKey?: unknown } : null
        if (!value || typeof value !== 'object') return EMPTY
        if (value.version === 2 && value.groups && typeof value.groups === 'object') {
            const groups: Record<string, SessionTab[]> = {}
            for (const [key, tabs] of Object.entries(value.groups as Record<string, unknown>)) {
                const parsed = parseTabs(tabs)
                if (parsed.length > 0) groups[key] = parsed
            }
            const active = typeof value.activeDirectoryKey === 'string' && value.activeDirectoryKey
                ? value.activeDirectoryKey
                : null
            return { activeDirectoryKey: active, groups }
        }
        if (Array.isArray(value.tabs)) {
            const tabs = parseTabs(value.tabs)
            if (tabs.length === 0) return EMPTY
            return { activeDirectoryKey: null, groups: { [LEGACY_DIRECTORY_KEY]: tabs } }
        }
        return EMPTY
    } catch {
        return EMPTY
    }
}

function sameList(left: SessionTab[], right: SessionTab[]): boolean {
    if (left.length !== right.length) return false
    return left.every((tab, index) => {
        const other = right[index]
        return other !== undefined && tab.id === other.id && tab.pinned === other.pinned && tab.activatedAt === other.activatedAt
    })
}

function sameState(left: SessionTabGroups, right: SessionTabGroups): boolean {
    if (left.activeDirectoryKey !== right.activeDirectoryKey) return false
    const leftKeys = Object.keys(left.groups)
    if (leftKeys.length !== Object.keys(right.groups).length) return false
    return leftKeys.every(key => {
        const other = right.groups[key]
        return other !== undefined && sameList(left.groups[key]!, other)
    })
}

type Store = { state: SessionTabGroups; listeners: Set<() => void>; key: string }
const stores = new Map<string, Store>()
let storageListenerInstalled = false

function readStored(key: string): string | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    } catch {
        return null
    }
}

/** 别的窗口写入 localStorage 时，本窗口的 storage 事件把内存状态换成那份。同窗口的写入不会触发。 */
function installStorageListener(): void {
    if (storageListenerInstalled || typeof window === 'undefined') return
    storageListenerInstalled = true
    window.addEventListener('storage', (event: StorageEvent) => {
        for (const store of stores.values()) {
            if (event.key !== null && event.key !== store.key) continue
            const next = parse(readStored(store.key))
            if (sameState(store.state, next)) continue
            store.state = next
            for (const listener of store.listeners) listener()
        }
    })
}

function storeFor(scope: string): Store {
    installStorageListener()
    let store = stores.get(scope)
    if (!store) {
        const key = `hapi-session-tabs:${scope}`
        store = { state: parse(readStored(key)), listeners: new Set(), key }
        stores.set(scope, store)
    }
    return store
}

export function getSessionTabsSnapshot(scope: string): SessionTabGroups {
    return storeFor(scope).state
}

export function updateSessionTabs(scope: string, update: (state: SessionTabGroups) => SessionTabGroups): void {
    const store = storeFor(scope)
    const next = update(store.state)
    if (next === store.state) return
    store.state = next
    try {
        localStorage.setItem(store.key, JSON.stringify({
            version: 2,
            activeDirectoryKey: next.activeDirectoryKey,
            groups: next.groups,
        }))
    } catch {
        // 存不下只影响刷新后恢复
    }
    for (const listener of store.listeners) listener()
}

export function useSessionTabsState(scope: string): SessionTabGroups {
    return useSyncExternalStore(
        listener => {
            const store = storeFor(scope)
            store.listeners.add(listener)
            return () => store.listeners.delete(listener)
        },
        () => getSessionTabsSnapshot(scope),
        () => getSessionTabsSnapshot(scope)
    )
}

/** 仅供测试：清掉内存里的 store。 */
export function __resetSessionTabsForTests(): void {
    stores.clear()
}
