import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
    COMPOSER_DOCK_SLOTS,
    ChatSlotHost,
    defineChatSlots,
    type ComposerDockSlotContext,
} from '@/components/AssistantChat/slotRegistry'
import { TURN_SLOTS } from '@/components/AssistantChat/messages/TimelineTurnBlock'

describe('slotRegistry & ChatSlotHost', () => {
    it('sorts declarative slots by order ascending with deterministic id tie-breaker', () => {
        const slots = defineChatSlots<{ label: string }>([
            { id: 'c-slot', order: 20, Component: ({ ctx }) => <span>{ctx.label}-c</span> },
            { id: 'a-slot', order: 10, Component: ({ ctx }) => <span>{ctx.label}-a</span> },
            { id: 'b-slot', order: 20, Component: ({ ctx }) => <span>{ctx.label}-b</span> },
        ])

        expect(slots.map((slot) => slot.id)).toEqual(['a-slot', 'b-slot', 'c-slot'])
        expect(Object.isFrozen(slots)).toBe(true)
    })

    it('isolates crashing slots (both Component and visible predicate) inside FeatureErrorBoundary while keeping siblings alive and recovering on resetKey change', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            type TestCtx = { crashRender: boolean; crashVisible: boolean; showOptional: boolean }
            const slots = defineChatSlots<TestCtx>([
                {
                    id: 'slot-first',
                    order: 10,
                    Component: () => <div data-testid="slot-first">First OK</div>,
                },
                {
                    id: 'slot-middle',
                    order: 20,
                    visible: (ctx) => {
                        if (ctx.crashVisible) {
                            throw new Error('visible predicate crashed')
                        }
                        return ctx.showOptional
                    },
                    Component: ({ ctx }) => {
                        if (ctx.crashRender) {
                            throw new Error('slot render crashed')
                        }
                        return <div data-testid="slot-middle">Middle OK</div>
                    },
                },
                {
                    id: 'slot-last',
                    order: 30,
                    Component: () => <div data-testid="slot-last">Last OK</div>,
                },
            ])

            const { rerender } = render(
                <ChatSlotHost
                    slots={slots}
                    ctx={{ crashRender: false, crashVisible: false, showOptional: false }}
                    resetKey="turn-1"
                />
            )

            expect(screen.getByTestId('slot-first')).toBeTruthy()
            expect(screen.queryByTestId('slot-middle')).toBeNull()
            expect(screen.getByTestId('slot-last')).toBeTruthy()

            // Crash inside Component: siblings remain mounted
            rerender(
                <ChatSlotHost
                    slots={slots}
                    ctx={{ crashRender: true, crashVisible: false, showOptional: true }}
                    resetKey="turn-1"
                />
            )
            expect(screen.getByTestId('slot-first')).toBeTruthy()
            expect(screen.queryByTestId('slot-middle')).toBeNull()
            expect(screen.getByTestId('slot-last')).toBeTruthy()

            // Changing resetKey recovers the crashed slot
            rerender(
                <ChatSlotHost
                    slots={slots}
                    ctx={{ crashRender: false, crashVisible: false, showOptional: true }}
                    resetKey="turn-2"
                />
            )
            expect(screen.getByTestId('slot-middle')).toBeTruthy()

            // Crash inside visible() predicate is also caught by the slot's FeatureErrorBoundary
            rerender(
                <ChatSlotHost
                    slots={slots}
                    ctx={{ crashRender: false, crashVisible: true, showOptional: true }}
                    resetKey="turn-2"
                />
            )
            expect(screen.getByTestId('slot-first')).toBeTruthy()
            expect(screen.queryByTestId('slot-middle')).toBeNull()
            expect(screen.getByTestId('slot-last')).toBeTruthy()
        } finally {
            spy.mockRestore()
        }
    })

    it('declares canonical TURN_SLOTS and COMPOSER_DOCK_SLOTS in order', () => {
        expect(TURN_SLOTS.map((slot) => ({ id: slot.id, order: slot.order }))).toEqual([
            { id: 'turn-rail', order: 10 },
            { id: 'turn-todo', order: 20 },
            { id: 'turn-answer', order: 30 },
        ])

        expect(COMPOSER_DOCK_SLOTS.map((slot) => ({ id: slot.id, order: slot.order }))).toEqual([
            { id: 'todo-panel', order: 10 },
            { id: 'scratchlist-drawer', order: 20 },
            { id: 'queued-messages-bar', order: 30 },
        ])

        const scratchlistSlot = COMPOSER_DOCK_SLOTS.find((slot) => slot.id === 'scratchlist-drawer')
        expect(scratchlistSlot?.visible?.({ scratchlistMode: false } as ComposerDockSlotContext)).toBe(false)
        expect(scratchlistSlot?.visible?.({ scratchlistMode: true } as ComposerDockSlotContext)).toBe(true)
    })
})
