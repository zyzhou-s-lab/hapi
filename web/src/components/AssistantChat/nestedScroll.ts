// Pure DOM helpers for nested scrollable blocks inside the chat thread viewport.
const VERTICAL_OVERFLOW_CLASS_RE = /\boverflow-(?:y-)?(?:auto|scroll)\b/
const HORIZONTAL_ONLY_OVERFLOW_CLASS_RE = /\boverflow-x-(?:auto|scroll|hidden|clip)\b/
const VERTICAL_OVERFLOW_HIDDEN_CLASS_RE = /\boverflow-(?:y-)?(?:hidden|clip|visible)\b/

const computedVerticalOverflowCache = new WeakMap<
    HTMLElement,
    { className: string; inlineOverflow: string; inlineOverflowY: string; scrollable: boolean }
>()

export function hasVerticalOverflowStyle(element: HTMLElement): boolean {
    const className = typeof element.className === 'string' ? element.className : ''
    if (VERTICAL_OVERFLOW_HIDDEN_CLASS_RE.test(className)) {
        return false
    }
    if (VERTICAL_OVERFLOW_CLASS_RE.test(className)) {
        return true
    }
    const inlineOverflowY = element.style?.overflowY ?? ''
    const inlineOverflow = element.style?.overflow ?? ''
    if (
        inlineOverflowY === 'auto'
        || inlineOverflowY === 'scroll'
        || inlineOverflowY === 'overlay'
        || inlineOverflow === 'auto'
        || inlineOverflow === 'scroll'
        || inlineOverflow === 'overlay'
    ) {
        return true
    }
    if (
        inlineOverflowY === 'hidden'
        || inlineOverflowY === 'clip'
        || inlineOverflowY === 'visible'
        || inlineOverflow === 'hidden'
        || inlineOverflow === 'clip'
        || inlineOverflow === 'visible'
    ) {
        return false
    }
    // Per CSS Overflow, setting overflow-x to auto/scroll coerces an unset
    // overflow-y: visible to auto in computed styles. Short-circuiting pure
    // overflow-x-* utility classes avoids per-event getComputedStyle calls on
    // horizontal code/table wrappers; any container that combines overflow-x-auto
    // with max-h-* to scroll on both axes should use overflow-auto or mark itself
    // with data-hapi-nested-scroll="true".
    if (HORIZONTAL_ONLY_OVERFLOW_CLASS_RE.test(className)) {
        return false
    }
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
        return false
    }
    const cached = computedVerticalOverflowCache.get(element)
    if (
        cached
        && cached.className === className
        && cached.inlineOverflow === inlineOverflow
        && cached.inlineOverflowY === inlineOverflowY
    ) {
        return cached.scrollable
    }
    const style = window.getComputedStyle(element)
    const scrollable =
        style.overflowY === 'auto'
        || style.overflowY === 'scroll'
        || style.overflowY === 'overlay'
    computedVerticalOverflowCache.set(element, {
        className,
        inlineOverflow,
        inlineOverflowY,
        scrollable
    })
    return scrollable
}

export function getEventVerticalScrollDelta(event: Event, deltaY?: number): number {
    if (typeof deltaY === 'number' && Number.isFinite(deltaY)) {
        return deltaY
    }
    if (typeof WheelEvent !== 'undefined' && event instanceof WheelEvent && Number.isFinite(event.deltaY)) {
        return event.deltaY
    }
    if ('deltaY' in event) {
        const candidate = (event as { deltaY?: unknown }).deltaY
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate
        }
    }
    return 0
}

export function hasScrollableNestedDescendant(element: HTMLElement): boolean {
    const candidates = element.querySelectorAll<HTMLElement>(
        '[data-hapi-code-body="true"], .overflow-auto, .overflow-y-auto, .overflow-scroll, .overflow-y-scroll'
    )
    for (const child of candidates) {
        if (child.scrollHeight > child.clientHeight && hasVerticalOverflowStyle(child)) {
            return true
        }
    }
    return false
}

export function isNestedScrollableElement(element: HTMLElement, deltaY = 0): boolean {
    if (element.classList.contains('chat-scroll-y') || element.classList.contains('happy-message')) {
        return false
    }
    const isExplicitNestedScroll = element.getAttribute('data-hapi-nested-scroll') === 'true'
    if (isExplicitNestedScroll && element.clientHeight === 0 && element.scrollHeight === 0) {
        return true
    }
    if (element.scrollHeight <= element.clientHeight) {
        return isExplicitNestedScroll && deltaY === 0 && hasScrollableNestedDescendant(element)
    }
    if (!isExplicitNestedScroll && !hasVerticalOverflowStyle(element)) {
        return false
    }
    if (deltaY < 0) {
        return element.scrollTop > 1
    }
    if (deltaY > 0) {
        return element.scrollTop + element.clientHeight < element.scrollHeight - 1
    }
    return true
}

export function isNestedScrollEvent(event: Event, boundary?: Element | null, deltaY?: number): boolean {
    const target = event.target
    let current = typeof Element !== 'undefined' && target instanceof Element
        ? target
        : typeof Node !== 'undefined' && target instanceof Node
            ? target.parentElement
            : null
    const scrollDeltaY = getEventVerticalScrollDelta(event, deltaY)
    while (current && current !== boundary) {
        if (current.classList.contains('chat-scroll-y')) {
            return false
        }
        if (current instanceof HTMLElement) {
            if (isNestedScrollableElement(current, scrollDeltaY)) {
                return true
            }
        } else if (current.getAttribute('data-hapi-nested-scroll') === 'true') {
            return true
        }
        current = current.parentElement
    }
    return false
}

export function findNestedScrollContainer(target: EventTarget | null, boundary?: Element | null): HTMLElement | null {
    let current = typeof Element !== 'undefined' && target instanceof Element
        ? target
        : typeof Node !== 'undefined' && target instanceof Node
            ? target.parentElement
            : null
    while (current && current !== boundary) {
        if (current.classList.contains('chat-scroll-y')) {
            return null
        }
        if (current instanceof HTMLElement && isNestedScrollableElement(current, 0)) {
            return current
        }
        current = current.parentElement
    }
    return null
}

export const NESTED_SCROLL_KEYS: Record<string, true> = {
    ArrowUp: true,
    ArrowDown: true,
    PageUp: true,
    PageDown: true,
    Home: true,
    End: true,
    ' ': true
}

export function applyKeyboardScrollToNestedContainer(container: HTMLElement, key: string, shiftKey = false): boolean {
    if (!NESTED_SCROLL_KEYS[key]) {
        return false
    }
    const target = container.scrollHeight > container.clientHeight
        ? container
        : Array.from(container.querySelectorAll<HTMLElement>('[data-hapi-code-body="true"], .overflow-auto, .overflow-y-auto'))
            .find((child) => child.scrollHeight > child.clientHeight) ?? container
    const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight)
    const pageStep = Math.max(1, Math.round((target.clientHeight || 200) * 0.9))
    if (key === 'Home') {
        target.scrollTop = 0
    } else if (key === 'End') {
        target.scrollTop = maxScrollTop
    } else if (key === 'PageUp' || (key === ' ' && shiftKey)) {
        target.scrollTop = Math.max(0, target.scrollTop - pageStep)
    } else if (key === 'PageDown' || (key === ' ' && !shiftKey)) {
        target.scrollTop = Math.min(maxScrollTop, target.scrollTop + pageStep)
    } else if (key === 'ArrowUp') {
        target.scrollTop = Math.max(0, target.scrollTop - 40)
    } else if (key === 'ArrowDown') {
        target.scrollTop = Math.min(maxScrollTop, target.scrollTop + 40)
    }
    return true
}

export function isHorizontalOnlyScrollElement(element: HTMLElement): boolean {
    if (element.classList.contains('chat-scroll-y') || element.classList.contains('happy-message')) {
        return false
    }
    if (isNestedScrollableElement(element, 0)) {
        return false
    }
    if (element.getAttribute('data-hapi-code-body') === 'true') {
        return true
    }
    const className = typeof element.className === 'string' ? element.className : ''
    if (/\boverflow-x-(?:auto|scroll)\b/.test(className)) {
        return true
    }
    const inlineOverflowX = element.style?.overflowX ?? ''
    if (inlineOverflowX === 'auto' || inlineOverflowX === 'scroll') {
        return true
    }
    return element.scrollWidth > element.clientWidth && element.scrollHeight <= element.clientHeight + 1
}

export function isHorizontalOnlyScrollEvent(event: Event, boundary?: Element | null): boolean {
    const target = event.target
    let current = typeof Element !== 'undefined' && target instanceof Element
        ? target
        : typeof Node !== 'undefined' && target instanceof Node
            ? target.parentElement
            : null
    while (current && current !== boundary) {
        if (current.classList.contains('chat-scroll-y')) {
            return false
        }
        if (current instanceof HTMLElement) {
            if (isNestedScrollableElement(current, 0)) {
                return false
            }
            if (isHorizontalOnlyScrollElement(current)) {
                return true
            }
        }
        current = current.parentElement
    }
    return false
}

