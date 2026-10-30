import { useEffect, useState } from 'react'
import { Manager, type Socket } from 'socket.io-client'
import { applyTrainingBatch, type TrainingBatchPoint, type TrainingSeries } from '@/fork-features/work-lines/trainingSeries'

export type TrainingSocketState = {
    status: 'connecting' | 'live' | 'unavailable'
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

export function reduceTrainingFrame(state: TrainingSocketState, frame: TrainingFrame): TrainingSocketState {
    return {
        status: 'live',
        message: frame.lastError ?? null,
        finished: frame.reset ? Boolean(frame.finished) : state.finished || Boolean(frame.finished),
        series: applyTrainingBatch(state.series, frame.batch, Boolean(frame.reset)),
    }
}

export function emptyTrainingState(): TrainingSocketState {
    return { status: 'connecting', message: null, finished: false, series: [] }
}

export function useTrainingSocket(options: { baseUrl: string; token: string; run: string }): TrainingSocketState {
    const [state, setState] = useState<TrainingSocketState>(emptyTrainingState)
    const { baseUrl, token, run } = options

    useEffect(() => {
        if (!token || !run) {
            setState({ status: 'unavailable', message: null, finished: false, series: [] })
            return
        }
        let socket: Socket | null = null
        let active = true
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

        const forRun = (frame: TrainingFrame) => frame.run === run

        socket.on('connect', () => {
            if (!active) return
            setState((current) => ({ ...current, status: 'connecting', message: null }))
            socket?.emit('training:subscribe', { run })
        })
        socket.on('training:history', (frame: TrainingFrame) => {
            if (!active || !forRun(frame)) return
            setState((current) => reduceTrainingFrame(current, frame))
        })
        socket.on('training:points', (frame: TrainingFrame) => {
            if (!active || !forRun(frame)) return
            setState((current) => reduceTrainingFrame(current, frame))
        })
        socket.on('training:error', (frame: { run?: string; message?: string }) => {
            if (!active || frame.run !== run) return
            setState({ status: 'unavailable', message: frame.message ?? null, finished: false, series: [] })
        })
        socket.on('disconnect', (reason: string) => {
            if (!active || reason === 'io client disconnect') return
            setState({ status: 'unavailable', message: null, finished: false, series: [] })
        })
        socket.on('connect_error', () => {
            if (!active) return
            setState({ status: 'unavailable', message: null, finished: false, series: [] })
        })
        socket.connect()

        return () => {
            active = false
            socket?.emit('training:unsubscribe', { run })
            socket?.removeAllListeners()
            socket?.disconnect()
            socket = null
        }
    }, [baseUrl, token, run])

    return state
}
