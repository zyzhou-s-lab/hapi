import { spawn, type ChildProcess } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { TrainingErrorPayload, TrainingHistoryPayload } from '@hapi/protocol'
import { READ_WANDB_SCRIPT } from './readWandbScript'

export type TrainingFrameEvent = 'training:history' | 'training:points' | 'training:error'

export function isWandbRunDir(runDir: string): boolean {
    const name = basename(runDir)
    const parent = basename(dirname(runDir))
    if (parent !== 'wandb') return false
    return /^run-.+$/.test(name) || /^offline-run-.+$/.test(name)
}

type TailLine =
    | { kind: 'point'; step: number; metric: string; value: number }
    | { kind: 'skip'; error: string }
    | { kind: 'exit' }
    | { kind: 'reset' }
    | { kind: 'fatal'; message: string }

export function parseTailLine(line: string): TailLine {
    let value: unknown
    try {
        value = JSON.parse(line)
    } catch {
        return { kind: 'skip', error: 'record did not parse' }
    }
    if (!value || typeof value !== 'object') return { kind: 'skip', error: 'record did not parse' }
    const record = value as { kind?: unknown; step?: unknown; metric?: unknown; value?: unknown; error?: unknown; message?: unknown }
    if (record.kind === 'point' && typeof record.step === 'number' && typeof record.metric === 'string' && typeof record.value === 'number') {
        return { kind: 'point', step: record.step, metric: record.metric, value: record.value }
    }
    if (record.kind === 'skip') return { kind: 'skip', error: typeof record.error === 'string' ? record.error : 'record did not parse' }
    if (record.kind === 'exit') return { kind: 'exit' }
    if (record.kind === 'reset') return { kind: 'reset' }
    if (record.kind === 'fatal') return { kind: 'fatal', message: typeof record.message === 'string' ? record.message : 'cannot read this run' }
    return { kind: 'skip', error: 'record did not parse' }
}

export function createTrainingPump(options: {
    run: string
    machineId: string
    emit: (event: TrainingFrameEvent, payload: TrainingHistoryPayload | TrainingErrorPayload) => void
    batchMs?: number
}): {
    push: (line: TailLine) => 'stop' | void
    stop: () => void
} {
    const batchMs = options.batchMs ?? 1000
    let historySent = false
    let finished = false
    let lastError: string | undefined
    let batch: { step: number; metric: string; value: number }[] = []
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
        if (!timer) return
        clearTimeout(timer)
        timer = null
    }

    const flush = () => {
        clearTimer()
        if (batch.length === 0 && !lastError && !finished) return
        const reset = !historySent
        options.emit(reset ? 'training:history' : 'training:points', {
            run: options.run,
            machineId: options.machineId,
            ...(reset ? { reset: true } : {}),
            ...(finished ? { finished: true } : {}),
            ...(lastError ? { lastError } : {}),
            ...(batch.length > 0 ? { batch } : {}),
        })
        historySent = true
        batch = []
        lastError = undefined
    }

    const schedule = () => {
        if (batchMs <= 0) {
            flush()
            return
        }
        if (timer) return
        timer = setTimeout(flush, batchMs)
    }

    return {
        push(line) {
            if (line.kind === 'fatal') {
                clearTimer()
                options.emit('training:error', { run: options.run, machineId: options.machineId, message: line.message })
                return 'stop'
            }
            if (line.kind === 'reset') {
                clearTimer()
                batch = []
                lastError = undefined
                finished = false
                historySent = true
                options.emit('training:history', { run: options.run, machineId: options.machineId, reset: true })
                historySent = false
                return
            }
            if (line.kind === 'exit') {
                finished = true
                flush()
                return 'stop'
            }
            if (line.kind === 'skip') {
                lastError = line.error
                schedule()
                return
            }
            if (!Number.isFinite(line.step) || !Number.isFinite(line.value) || line.metric.length === 0) {
                lastError = 'record did not parse'
                schedule()
                return
            }
            batch.push({ step: line.step, metric: line.metric, value: line.value })
            schedule()
            return
        },
        stop() {
            clearTimer()
        },
    }
}

async function wandbFile(runDir: string): Promise<string | null> {
    let names: string[]
    try {
        names = await readdir(runDir)
    } catch {
        return null
    }
    const files = names.filter((name) => /^run-.*\.wandb$/.test(name)).sort()
    const file = files.at(-1)
    return file ? join(runDir, file) : null
}

export function startTrainingTail(options: {
    run: string
    runDir: string
    machineId: string
    emit: (event: TrainingFrameEvent, payload: TrainingHistoryPayload | TrainingErrorPayload) => void
    batchMs?: number
    spawnPython?: (script: string, file: string) => ChildProcess
}): { stop: () => void } {
    let stopped = false
    let child: ChildProcess | null = null
    const pump = createTrainingPump(options)
    const fail = (message: string) => {
        if (stopped) return
        options.emit('training:error', { run: options.run, machineId: options.machineId, message })
    }

    void (async () => {
        if (!isWandbRunDir(options.runDir)) {
            fail('cannot read this run')
            return
        }
        const file = await wandbFile(options.runDir)
        if (stopped) return
        if (!file) {
            fail('cannot read this run')
            return
        }
        const launch = options.spawnPython ?? ((script, wandbPath) => spawn('python3', ['-c', script, wandbPath], { stdio: ['ignore', 'pipe', 'pipe'] }))
        let reader: ChildProcess
        try {
            reader = launch(READ_WANDB_SCRIPT, file)
        } catch {
            fail('wandb is not available')
            return
        }
        child = reader
        const stdout = reader.stdout
        if (!stdout) {
            fail('wandb is not available')
            return
        }
        let buffer = ''
        let fatal = false
        stdout.setEncoding('utf8')
        stdout.on('data', (chunk: string) => {
            buffer += chunk
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
                const line = buffer.slice(0, newline).trim()
                buffer = buffer.slice(newline + 1)
                if (line && pump.push(parseTailLine(line)) === 'stop') {
                    fatal = true
                    child?.kill()
                }
                newline = buffer.indexOf('\n')
            }
        })
        reader.on('error', () => {
            fatal = true
            fail('wandb is not available')
        })
        reader.on('exit', (code) => {
            if (stopped || fatal || code === 0) return
            fail('cannot read this run')
        })
    })()

    return {
        stop() {
            stopped = true
            pump.stop()
            child?.kill()
        },
    }
}

export function attachTrainingHandlers(socket: {
    on: (event: string, handler: (data?: unknown) => void) => void
    emit: (event: TrainingFrameEvent, payload: TrainingHistoryPayload | TrainingErrorPayload) => void
}, machineId: string, start: typeof startTrainingTail = startTrainingTail): () => void {
    const tails = new Map<string, { stop: () => void }>()
    const stopRun = (run: string) => {
        tails.get(run)?.stop()
        tails.delete(run)
    }
    const stopAll = () => {
        for (const tail of tails.values()) tail.stop()
        tails.clear()
    }
    socket.on('training:subscribe', (data) => {
        const payload = data as { run?: unknown; runDir?: unknown; machineId?: unknown } | undefined
        if (!payload || payload.machineId !== machineId || typeof payload.run !== 'string' || typeof payload.runDir !== 'string') return
        stopRun(payload.run)
        tails.set(payload.run, start({
            run: payload.run,
            runDir: payload.runDir,
            machineId,
            emit: (event, frame) => socket.emit(event, frame),
        }))
    })
    socket.on('training:unsubscribe', (data) => {
        const run = (data as { run?: unknown } | undefined)?.run
        if (typeof run === 'string') stopRun(run)
    })
    socket.on('disconnect', () => stopAll())
    return stopAll
}
