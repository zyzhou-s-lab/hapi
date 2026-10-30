export type TabShortcut = 'close' | 'new'

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'> & {
    getModifierState?: (key: string) => boolean
}

/**
 * 标签快捷键：Ctrl/⌘+W、Alt/⌥+W 关闭当前会话标签；Ctrl/⌘+T、Alt/⌥+T 新建会话。
 * 普通浏览器标签页里 Ctrl/⌘+W、Ctrl/⌘+T 由浏览器先处理、页面收不到（Chrome 把它们列为保留键），
 * 只有安装成应用（独立窗口）或全屏时才会交给页面；Alt 组合在哪都能用。
 * Alt 组合按 code 判断：macOS 上 ⌥+W 的 key 是「∑」。
 * AltGr（Ctrl+Alt，或 getModifierState('AltGraph')）是在打字符，不是快捷键。
 */
export function matchTabShortcut(event: KeyLike): TabShortcut | null {
    if (event.repeat || event.isComposing || event.shiftKey) return null
    if (event.getModifierState?.('AltGraph')) return null
    const primary = (event.ctrlKey || event.metaKey) && !event.altKey
    const alt = event.altKey && !event.ctrlKey && !event.metaKey
    if (!primary && !alt) return null
    const letter = alt ? event.code : (event.key.length === 1 ? `Key${event.key.toUpperCase()}` : event.code)
    if (letter === 'KeyW') return 'close'
    if (letter === 'KeyT') return 'new'
    return null
}

/**
 * Ctrl/⌘+W 只在当前会话确实开着标签时才拿走事件。
 * 否则留给浏览器：PWA 独立窗口靠这个组合关掉窗口。
 */
export function canCloseOpenTab(selectedSessionId: string | null, openTabIds: readonly string[]): boolean {
    return selectedSessionId != null && openTabIds.includes(selectedSessionId)
}

/** 终端里 Ctrl+W 是删词，焦点在终端时快捷键一律不拦。 */
export function isTerminalTarget(target: EventTarget | null): boolean {
    return typeof Element !== 'undefined' && target instanceof Element && target.closest('.xterm') !== null
}

const NON_TEXT_INPUT: Record<string, true> = {
    button: true,
    checkbox: true,
    color: true,
    file: true,
    hidden: true,
    radio: true,
    range: true,
    reset: true,
    submit: true,
}

/** 文本输入、多行框、下拉和 contenteditable。Alt 快捷键在这里不拦，好让 ⌥/AltGr 打出字符。 */
export function isEditableTarget(target: EventTarget | null): boolean {
    if (typeof Element === 'undefined' || !(target instanceof Element)) return false
    const field = target.closest('textarea, select, input, [contenteditable]:not([contenteditable="false"])')
    if (!field) return false
    if (field instanceof HTMLInputElement && NON_TEXT_INPUT[field.type]) return false
    return true
}
