import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTrainingSocket } from './useTrainingSocket'

type Listener = (payload?: unknown) => void

const socket = {
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    listeners: new Map<string, Listener>(),
    on(event: string, listener: Listener) {
        this.listeners.set(event, listener)
    },
    fire(event: string, payload?: unknown) {
        this.listeners.get(event)?.(payload)
    },
}

vi.mock('socket.io-client', () => ({
    Manager: class {
        socket() {
            return socket
        }
    },
}))

afterEach(() => {
    socket.emit.mockClear()
    socket.listeners.clear()
    vi.useRealTimers()
})

describe('useTrainingSocket', () => {
    it('keeps points when the runner drops and subscribes again', () => {
        vi.useFakeTimers()
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { result } = renderHook(() => useTrainingSocket({ baseUrl: 'http://hub', token: 't', run: 'exp-1' }))
        act(() => socket.fire('connect'))
        expect(socket.emit).toHaveBeenCalledWith('training:subscribe', { run: 'exp-1' })
        act(() => socket.fire('training:history', { run: 'exp-1', reset: true, batch: [{ step: 1, metric: 'loss', value: 0.2 }] }))
        act(() => socket.fire('training:error', { run: 'exp-1', message: 'Runner is not connected.' }))
        expect(result.current.series[0]?.points).toEqual([{ step: 1, value: 0.2 }])
        expect(result.current.status).toBe('reconnecting')
        expect(logged).toHaveBeenCalledWith('Runner is not connected.')
        act(() => { vi.advanceTimersByTime(1000) })
        expect(socket.emit).toHaveBeenCalledTimes(2)
        act(() => socket.fire('training:error', { run: 'exp-1', message: 'cannot read this run' }))
        expect(result.current.status).toBe('unavailable')
        act(() => { vi.advanceTimersByTime(5000) })
        expect(socket.emit).toHaveBeenCalledTimes(2)
        act(() => socket.fire('disconnect', 'transport close'))
        expect(result.current.series[0]?.points).toEqual([{ step: 1, value: 0.2 }])
    })
})
