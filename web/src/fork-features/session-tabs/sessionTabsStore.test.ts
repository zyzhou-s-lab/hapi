import { beforeEach, describe, expect, it } from 'vitest'
import {
    MAX_SESSION_TABS,
    __resetSessionTabsForTests,
    adoptLegacyTabs,
    allTabIds,
    applyToGroup,
    closeTabInDirectory,
    closeOtherTabs,
    closeTab,
    closeTabsToRight,
    moveTab,
    openTab,
    openTabInDirectory,
    pruneDeletedTabs,
    rehomeTabs,
    confirmedDeletedIds,
    tabsMissingFromFirstList,
    togglePinTab,
    getSessionTabsSnapshot,
    updateSessionTabs,
    LEGACY_DIRECTORY_KEY,
    type SessionTabGroups,
    type SessionTabsState,
} from './sessionTabsStore'

const ids = (state: SessionTabsState) => state.tabs.map(tab => tab.id)
const open = (...list: string[]) => list.reduce<SessionTabsState>((state, id, index) => openTab(state, id, index + 1), { tabs: [] })
const empty = (): SessionTabGroups => ({ activeDirectoryKey: null, groups: {} })
const groupIds = (state: SessionTabGroups, key: string) => (state.groups[key] ?? []).map(tab => tab.id)

describe('session tabs', () => {
    beforeEach(() => {
        localStorage.clear()
        __resetSessionTabsForTests()
    })

    it('appends new sessions and keeps the order when an existing tab is re-opened', () => {
        let state = open('a', 'b', 'c')
        state = openTab(state, 'a', 99)
        expect(ids(state)).toEqual(['a', 'b', 'c'])
        expect(state.tabs[0]!.activatedAt).toBe(99)
    })

    it('evicts the least recently activated unpinned tab beyond the limit, never the one being opened', () => {
        let state = open(...Array.from({ length: MAX_SESSION_TABS }, (_, i) => `s${i}`))
        state = togglePinTab(state, 's0')
        state = openTab(state, 's1', 1000)
        state = openTab(state, 'new', 1001)
        expect(state.tabs).toHaveLength(MAX_SESSION_TABS)
        expect(ids(state)).toContain('s0')
        expect(ids(state)).toContain('s1')
        expect(ids(state)).not.toContain('s2')
        expect(ids(state).at(-1)).toBe('new')
    })

    it('counts pinned tabs toward the cap and will not open a 13th when all are pinned', () => {
        let state = open(...Array.from({ length: MAX_SESSION_TABS }, (_, i) => `s${i}`))
        for (let i = 0; i < MAX_SESSION_TABS; i++) state = togglePinTab(state, `s${i}`)
        expect(openTab(state, 'extra', 50)).toBe(state)
        expect(state.tabs).toHaveLength(MAX_SESSION_TABS)
    })

    it('restores at most the same cap, keeping pinned tabs first', () => {
        const tabs = [
            ...Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, pinned: true, activatedAt: i })),
            ...Array.from({ length: MAX_SESSION_TABS }, (_, i) => ({ id: `u${i}`, pinned: false, activatedAt: 10 + i })),
        ]
        localStorage.setItem('hapi-session-tabs:cap', JSON.stringify({ tabs }))
        const loaded = getSessionTabsSnapshot('cap')
        expect(loaded.groups[LEGACY_DIRECTORY_KEY]).toHaveLength(MAX_SESSION_TABS)
        expect(loaded.groups[LEGACY_DIRECTORY_KEY]!.filter(tab => tab.pinned).map(tab => tab.id)).toEqual(['p0', 'p1', 'p2'])
    })

    it('closing picks the right neighbour, then the left one', () => {
        const state = open('a', 'b', 'c')
        expect(closeTab(state, 'b')).toMatchObject({ neighbor: 'c' })
        expect(closeTab(state, 'c')).toMatchObject({ neighbor: 'b' })
        expect(closeTab(open('a'), 'a')).toMatchObject({ neighbor: null })
        expect(ids(closeTab(state, 'missing').state)).toEqual(['a', 'b', 'c'])
    })

    it('pins move to the front, close-others and close-to-right keep pinned tabs', () => {
        let state = open('a', 'b', 'c', 'd')
        state = togglePinTab(state, 'c')
        expect(ids(state)).toEqual(['c', 'a', 'b', 'd'])
        expect(ids(closeOtherTabs(state, 'b'))).toEqual(['c', 'b'])
        expect(ids(closeTabsToRight(state, 'a'))).toEqual(['c', 'a'])
        // 取消固定后留在非固定区的最前面（与浏览器一致），而不是跳回固定前的位置。
        state = togglePinTab(state, 'c')
        expect(ids(state)).toEqual(['c', 'a', 'b', 'd'])
        expect(state.tabs.every(tab => !tab.pinned)).toBe(true)
    })

    it('drag reorders within the same pin group only', () => {
        let state = open('a', 'b', 'c')
        expect(ids(moveTab(state, 'c', 'a'))).toEqual(['c', 'a', 'b'])
        state = togglePinTab(state, 'b')
        expect(ids(moveTab(state, 'c', 'b'))).toEqual(['b', 'a', 'c'])
    })

    it('drops a tab missing from the first complete list, except one opened in this window', () => {
        const state: SessionTabGroups = {
            activeDirectoryKey: 'dir',
            groups: { dir: [{ id: 'a', pinned: false, activatedAt: 1 }, { id: 'b', pinned: true, activatedAt: 2 }] },
        }
        expect(confirmedDeletedIds(null, new Set(['b'])).size).toBe(0)
        const first = tabsMissingFromFirstList(['a', 'b'], new Set(['b']), new Set())
        expect([...first]).toEqual(['a'])
        expect(groupIds(pruneDeletedTabs(state, first), 'dir')).toEqual(['b'])
        expect([...tabsMissingFromFirstList(['a', 'b'], new Set(['b']), new Set(['a']))]).toEqual([])
        expect([...tabsMissingFromFirstList(['a', 'new'], new Set(), new Set(), new Set(['a']))]).toEqual(['a'])
        expect([...confirmedDeletedIds(new Set(['a', 'b']), new Set(['b']))]).toEqual(['a'])
        expect(pruneDeletedTabs(state, new Set())).toBe(state)
    })

    it('keeps each directory strip, including order and pins, and caps each strip on its own', () => {
        let state = empty()
        state = openTabInDirectory(state, 'd1', 'a', 1).state
        state = openTabInDirectory(state, 'd1', 'b', 2).state
        state = applyToGroup(state, 'd1', list => togglePinTab(list, 'b'))
        state = openTabInDirectory(state, 'd2', 'c', 3).state
        expect(state.activeDirectoryKey).toBe('d2')
        expect(groupIds(state, 'd1')).toEqual(['b', 'a'])
        expect(state.groups.d1!.find(tab => tab.id === 'b')!.pinned).toBe(true)

        state = openTabInDirectory(state, 'd1', 'a', 4).state
        expect(state.activeDirectoryKey).toBe('d1')
        expect(groupIds(state, 'd1')).toEqual(['b', 'a'])
        expect(state.groups.d1!.find(tab => tab.id === 'a')!.activatedAt).toBe(4)
        expect(groupIds(state, 'd2')).toEqual(['c'])

        for (let i = 0; i < MAX_SESSION_TABS; i++) state = openTabInDirectory(state, 'd1', `n${i}`, 10 + i).state
        expect(groupIds(state, 'd1')).toHaveLength(MAX_SESSION_TABS)
        expect(groupIds(state, 'd1')).not.toContain('a')
        expect(groupIds(state, 'd1')).toContain('b')
        expect(groupIds(state, 'd2')).toEqual(['c'])

        for (let i = 0; i < MAX_SESSION_TABS; i++) {
            state = openTabInDirectory(state, 'd2', `p${i}`, 100 + i).state
            state = applyToGroup(state, 'd2', list => list.tabs.some(tab => tab.id === `p${i}` && tab.pinned) ? list : togglePinTab(list, `p${i}`))
        }
        const rejected = openTabInDirectory(state, 'd2', 'extra', 200)
        expect(rejected.rejected).toBe('pinned-full')
        expect(groupIds(rejected.state, 'd2')).not.toContain('extra')
        expect(groupIds(rejected.state, 'd2')).toHaveLength(MAX_SESSION_TABS)
        expect(groupIds(state, 'd1').length).toBe(MAX_SESSION_TABS)
    })

    it('moves a tab when its session changes directory and drops it when the destination is full of pins', () => {
        let state = empty()
        state = openTabInDirectory(state, 'd1', 'a', 1).state
        state = applyToGroup(state, 'd1', list => togglePinTab(list, 'a'))
        state = openTabInDirectory(state, 'd2', 'b', 2).state
        const moved = rehomeTabs(state, new Map([['a', 'd2'], ['b', 'd2']]))
        expect(groupIds(moved, 'd1')).toEqual([])
        expect(groupIds(moved, 'd2')).toEqual(['a', 'b'])
        expect(moved.groups.d2!.find(tab => tab.id === 'a')!.pinned).toBe(true)
        expect(moved.activeDirectoryKey).toBe('d2')

        let full = empty()
        for (let i = 0; i < MAX_SESSION_TABS; i++) {
            full = openTabInDirectory(full, 'full', `p${i}`, i + 1).state
            full = applyToGroup(full, 'full', list => togglePinTab(list, `p${i}`))
        }
        full = openTabInDirectory(full, 'old', 'stuck', 50).state
        const dropped = rehomeTabs(full, new Map([['stuck', 'full']]))
        expect(dropped.groups.old).toBeUndefined()
        expect(allTabIds(dropped)).not.toContain('stuck')
        expect(dropped.activeDirectoryKey).toBe('full')
    })

    it('points the overview at another directory after the active group is emptied', () => {
        let state = empty()
        state = openTabInDirectory(state, 'd1', 'a', 1).state
        state = openTabInDirectory(state, 'd2', 'b', 5).state
        state = openTabInDirectory(state, 'd1', 'a', 9).state
        const closed = closeTabInDirectory(state, 'd1', 'a')
        expect(closed.state.groups.d1).toBeUndefined()
        expect(closed.state.activeDirectoryKey).toBe('d2')
    })

    it('splits a legacy flat list into directories and drops sessions that are already gone', () => {
        const state: SessionTabGroups = {
            activeDirectoryKey: null,
            groups: {
                [LEGACY_DIRECTORY_KEY]: [
                    { id: 'a', pinned: true, activatedAt: 1 },
                    { id: 'gone', pinned: false, activatedAt: 3 },
                    { id: 'b', pinned: false, activatedAt: 5 },
                ],
            },
        }
        const next = adoptLegacyTabs(state, new Map([['a', 'dirA'], ['b', 'dirB']]))
        expect(next.groups[LEGACY_DIRECTORY_KEY]).toBeUndefined()
        expect(groupIds(next, 'dirA')).toEqual(['a'])
        expect(groupIds(next, 'dirB')).toEqual(['b'])
        expect(next.activeDirectoryKey).toBe('dirB')
        expect(adoptLegacyTabs(next, new Map())).toBe(next)
    })

    it('persists per scope in localStorage', () => {
        updateSessionTabs('hub|1', state => openTabInDirectory(state, 'dir', 'x', 1).state)
        updateSessionTabs('hub|2', state => openTabInDirectory(state, 'dir', 'y', 1).state)
        const first = JSON.parse(localStorage.getItem('hapi-session-tabs:hub|1')!)
        const second = JSON.parse(localStorage.getItem('hapi-session-tabs:hub|2')!)
        expect(first.version).toBe(2)
        expect(first.groups.dir.map((tab: { id: string }) => tab.id)).toEqual(['x'])
        expect(second.groups.dir.map((tab: { id: string }) => tab.id)).toEqual(['y'])
    })

    it('replaces in-memory tabs when another window writes the same key', () => {
        updateSessionTabs('hub|1', state => openTabInDirectory(state, 'dir', 'x', 1).state)
        const raw = JSON.stringify({
            version: 2,
            activeDirectoryKey: 'dir',
            groups: { dir: [{ id: 'y', pinned: false, activatedAt: 4 }] },
        })
        localStorage.setItem('hapi-session-tabs:hub|1', raw)
        window.dispatchEvent(new StorageEvent('storage', { key: 'hapi-session-tabs:hub|1', newValue: raw }))
        expect(groupIds(getSessionTabsSnapshot('hub|1'), 'dir')).toEqual(['y'])

        window.dispatchEvent(new StorageEvent('storage', { key: 'hapi-session-tabs:hub|2', newValue: raw }))
        expect(groupIds(getSessionTabsSnapshot('hub|1'), 'dir')).toEqual(['y'])
    })
})
