import { spawn, type ChildProcess } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { MachinePathPolicy } from '../../api/machinePathPolicy'
import type { TrainingErrorPayload, TrainingHistoryPayload } from '@hapi/protocol'
import { READ_WANDB_SCRIPT } from './readWandbScript'

export type TrainingFrameEvent = 'training:history' | 'training:points' | 'training:error'

export function isWandbRunDir(runDir: string): boolean {
    const name = basename(runDir)
    const parent = basename(dirname(runDir))
    if (parent !== 'wandb') return false
    return /^run-.+$/.test(name) || /^offline-run-.+$/.test(name)
}

export async function resolveTrainingRunDir(runDir: string, policy?: Pick<MachinePathPolicy, 'resolveForCheck' | 'isWithinSpawnRoots'>): Promise<string | null> {
    if (!isWandbRunDir(runDir)) return null
    let resolved: string
    try {
        resolved = policy ? await policy.resolveForCheck(runDir) : await realpath(runDir)
    } catch {
        return null
    }
    if (!isWandbRunDir(resolved)) return null
    if (policy && !policy.isWithinSpawnRoots(resolved)) return null
    return resolved
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

const TRAINING_FRAME_POINTS = 2000
const TRAINING_FRAME_BYTES = 256 * 1024

function trainingFrameChunks(points: { step: number; metric: string; value: number }[]): { step: number; metric: string; value: number }[][] {
    const chunks: { step: number; metric: string; value: number }[][] = []
    let current: { step: number; metric: string; value: number }[] = []
    let bytes = 0
    for (const point of points) {
        const size = point.metric.length + 64
        if (current.length > 0 && (current.length >= TRAINING_FRAME_POINTS || bytes + size > TRAINING_FRAME_BYTES)) {
            chunks.push(current)
            current = []
            bytes = 0
        }
        current.push(point)
        bytes += size
    }
    if (current.length > 0) chunks.push(current)
    return chunks
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
        const parts = trainingFrameChunks(batch)
        const frames = parts.length > 0 ? parts : [[]]
        const reset = !historySent
        frames.forEach((part, index) => {
            const last = index === frames.length - 1
            options.emit(reset ? 'training:history' : 'training:points', {
                run: options.run,
                machineId: options.machineId,
                ...(reset && index === 0 ? { reset: true } : {}),
                ...(finished && last ? { finished: true } : {}),
                ...(lastError && last ? { lastError } : {}),
                ...(part.length > 0 ? { batch: part } : {}),
            })
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

export async function listWandbMetrics(runDir: string, policy?: Pick<MachinePathPolicy, 'resolveForCheck' | 'isWithinSpawnRoots'>): Promise<string[]> {
    const resolved = await resolveTrainingRunDir(runDir, policy)
    if (!resolved) throw new Error('cannot read this run')
    const file = await wandbFile(resolved)
    if (!file) throw new Error('cannot read this run')
    const child = spawn('python3', ['-c', READ_WANDB_SCRIPT, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    const names = new Set<string>()
    let buffer = ''
    return await new Promise((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            child.kill()
            if (error) reject(error)
            else resolve([...names].sort())
        }
        const timer = setTimeout(() => finish(), 2_000)
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
            buffer += chunk
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
                const line = buffer.slice(0, newline).trim()
                buffer = buffer.slice(newline + 1)
                if (line) {
                    const parsed = parseTailLine(line)
                    if (parsed.kind === 'point') names.add(parsed.metric)
                    if (parsed.kind === 'exit') finish()
                    if (parsed.kind === 'fatal') finish(new Error(parsed.message))
                }
                newline = buffer.indexOf('\n')
            }
        })
        child.on('error', (error) => finish(error))
        child.on('exit', () => finish())
    })
}

export function startTrainingTail(options: {
    run: string
    runDir: string
    machineId: string
    emit: (event: TrainingFrameEvent, payload: TrainingHistoryPayload | TrainingErrorPayload) => void
    batchMs?: number
    spawnPython?: (script: string, file: string) => ChildProcess
    policy?: Pick<MachinePathPolicy, 'resolveForCheck' | 'isWithinSpawnRoots'>
}): { stop: () => void } {
    let stopped = false
    let child: ChildProcess | null = null
    const pump = createTrainingPump(options)
    const fail = (message: string) => {
        if (stopped) return
        options.emit('training:error', { run: options.run, machineId: options.machineId, message })
    }

    void (async () => {
        const resolved = await resolveTrainingRunDir(options.runDir, options.policy)
        if (stopped) return
        if (!resolved) {
            fail('cannot read this run')
            return
        }
        const file = await wandbFile(resolved)
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
}, machineId: string, options: {
    start?: typeof startTrainingTail
    policy?: Pick<MachinePathPolicy, 'resolveForCheck' | 'isWithinSpawnRoots'>
} = {}): () => void {
    const start = options.start ?? startTrainingTail
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
            policy: options.policy,
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
