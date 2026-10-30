import { useEffect, useState } from 'react'
import { Manager, type Socket } from 'socket.io-client'
import { applyTrainingBatch, type TrainingBatchPoint, type TrainingSeries } from '@/fork-features/work-lines/trainingSeries'

export type TrainingSocketState = {
    status: 'connecting' | 'live' | 'reconnecting' | 'unavailable'
    message: string | null
    finished: boolean
    series: TrainingSeries[]
}

type TrainingFrame = {
    run?: string
    reset?: boolean
    finished?: boolean
    lastError?: string
    batch?: TrainingBatchPoint[]
}

const MESSAGE_KEYS: Record<string, string> = {
    'wandb is not available': 'work.trainingNoWandb',
    'cannot read this run': 'work.trainingUnreadable',
    'Runner is not connected.': 'work.trainingRunnerDown',
    'Training run is unavailable.': 'work.trainingUnavailable',
}

export function trainingMessageKey(raw: string | null | undefined): string {
    if (!raw) return 'work.trainingUnavailable'
    return MESSAGE_KEYS[raw] ?? 'work.trainingUnavailable'
}

export function nextSubscribeDelay(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, 5000)
}

export function reduceTrainingFrame(state: TrainingSocketState, frame: TrainingFrame): TrainingSocketState {
    const emptyReset = Boolean(frame.reset) && (frame.batch == null || frame.batch.length === 0)
    const replace = emptyReset || (Boolean(frame.reset) && state.series.length === 0)
    return {
        status: 'live',
        message: frame.lastError ?? null,
        finished: replace ? Boolean(frame.finished) : state.finished || Boolean(frame.finished),
        series: applyTrainingBatch(state.series, frame.batch, replace),
    }
}

export function reduceTrainingDisconnect(state: TrainingSocketState): TrainingSocketState {
    return { ...state, status: 'reconnecting' }
}

export function reduceTrainingError(state: TrainingSocketState, message: string | null): TrainingSocketState {
    return { ...state, status: 'reconnecting', message, finished: false }
}

export function emptyTrainingState(): TrainingSocketState {
    return { status: 'connecting', message: null, finished: false, series: [] }
}

export function useTrainingSocket(options: { baseUrl: string; token: string; run: string }): TrainingSocketState {
    const [state, setState] = useState<TrainingSocketState>(emptyTrainingState)
    const { baseUrl, token, run } = options

    useEffect(() => {
        if (!token || !run) {
            setState(emptyTrainingState())
            return
        }
        let socket: Socket | null = null
        let active = true
        let attempt = 0
        let retry: ReturnType<typeof setTimeout> | null = null
        setState(emptyTrainingState())
        const manager = new Manager(baseUrl, {
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['polling', 'websocket'],
            rememberUpgrade: true,
            autoConnect: false,
        })
        socket = manager.socket('/terminal', { auth: { token } })
        const subscribe = () => {
            socket?.emit('training:subscribe', { run })
        }
        const clearRetry = () => {
            if (!retry) return
            clearTimeout(retry)
            retry = null
        }
        const note = (raw: string | null) => {
            if (raw) console.error(raw)
        }

        socket.on('connect', () => {
            if (!active) return
            clearRetry()
            attempt = 0
            setState((current) => ({ ...current, status: current.series.length > 0 ? 'live' : 'connecting', message: null }))
            subscribe()
        })
        socket.on('training:history', (frame: TrainingFrame) => {
            if (!active || frame.run !== run) return
            note(frame.lastError ?? null)
            clearRetry()
            attempt = 0
            setState((current) => reduceTrainingFrame(current, frame))
        })
        socket.on('training:points', (frame: TrainingFrame) => {
            if (!active || frame.run !== run) return
            note(frame.lastError ?? null)
            setState((current) => reduceTrainingFrame(current, frame))
        })
        socket.on('training:error', (frame: { run?: string; message?: string }) => {
            if (!active || frame.run !== run) return
            note(frame.message ?? null)
            setState((current) => reduceTrainingError(current, frame.message ?? null))
            clearRetry()
            const delay = nextSubscribeDelay(attempt)
            attempt += 1
            retry = setTimeout(subscribe, delay)
        })
        socket.on('disconnect', (reason: string) => {
            if (!active || reason === 'io client disconnect') return
            setState((current) => reduceTrainingDisconnect(current))
        })
        socket.on('connect_error', () => {
            if (!active) return
            setState((current) => reduceTrainingDisconnect(current))
        })
        socket.connect()

        return () => {
            active = false
            clearRetry()
            socket?.emit('training:unsubscribe', { run })
            socket?.removeAllListeners()
            socket?.disconnect()
            socket = null
        }
    }, [baseUrl, token, run])

    return state
}
