import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { READ_WANDB_SCRIPT } from './readWandbScript'
import { attachTrainingHandlers, createTrainingPump, isWandbRunDir, parseTailLine, startTrainingTail, type TrainingFrameEvent } from './wandbTail'
import type { TrainingErrorPayload, TrainingHistoryPayload } from '@hapi/protocol'

afterEach(() => {
    vi.useRealTimers()
})

describe('wandb run directory', () => {
    it('accepts only a run directory inside wandb/', () => {
        expect(isWandbRunDir('/data/wandb/offline-run-1')).toBe(true)
        expect(isWandbRunDir('/data/wandb/run-abc')).toBe(true)
        expect(isWandbRunDir('/data/wandb')).toBe(false)
        expect(isWandbRunDir('/data/other/run-abc')).toBe(false)
    })
})

describe('training pump', () => {
    it('sends the first batch as history and a later batch as points', async () => {
        const frames: { event: TrainingFrameEvent; payload: TrainingHistoryPayload | TrainingErrorPayload }[] = []
        vi.useFakeTimers()
        const pump = createTrainingPump({
            run: 'exp-1',
            machineId: 'gpu',
            batchMs: 20,
            emit: (event, payload) => frames.push({ event, payload }),
        })
        pump.push({ kind: 'point', step: 1, metric: 'loss', value: 0.5 })
        pump.push({ kind: 'skip', error: 'history has no _step' })
        await vi.advanceTimersByTimeAsync(20)
        pump.push({ kind: 'point', step: 1, metric: 'loss', value: 0.4 })
        await vi.advanceTimersByTimeAsync(20)
        expect(frames.map((frame) => frame.event)).toEqual(['training:history', 'training:points'])
        expect(frames[0]?.payload).toMatchObject({
            reset: true,
            lastError: 'history has no _step',
            batch: [{ step: 1, metric: 'loss', value: 0.5 }],
        })
        expect(frames[1]?.payload).toMatchObject({ batch: [{ step: 1, metric: 'loss', value: 0.4 }] })
        expect(frames[1]?.payload).not.toHaveProperty('reset')
        pump.stop()
    })

    it('marks the exit frame finished and keeps the points', () => {
        const frames: TrainingHistoryPayload[] = []
        const pump = createTrainingPump({
            run: 'exp-1',
            machineId: 'gpu',
            emit: (event, payload) => {
                if (event !== 'training:error') frames.push(payload as TrainingHistoryPayload)
            },
        })
        pump.push({ kind: 'point', step: 2, metric: 'loss', value: 0.2 })
        expect(pump.push({ kind: 'exit' })).toBe('stop')
        expect(frames).toEqual([{
            run: 'exp-1',
            machineId: 'gpu',
            reset: true,
            finished: true,
            batch: [{ step: 2, metric: 'loss', value: 0.2 }],
        }])
    })

    it('resets with an empty history when the file shrinks', () => {
        const frames: TrainingHistoryPayload[] = []
        const pump = createTrainingPump({
            run: 'exp-1',
            machineId: 'gpu',
            emit: (_event, payload) => frames.push(payload as TrainingHistoryPayload),
        })
        pump.push({ kind: 'reset' })
        expect(frames).toEqual([{ run: 'exp-1', machineId: 'gpu', reset: true }])
        expect(JSON.stringify(frames)).not.toContain('/data')
    })

    it('turns a fatal line into an error and ignores a non-finite point', async () => {
        const frames: { event: string; payload: TrainingErrorPayload | TrainingHistoryPayload }[] = []
        vi.useFakeTimers()
        const pump = createTrainingPump({
            run: 'exp-1',
            machineId: 'gpu',
            batchMs: 20,
            emit: (event, payload) => frames.push({ event, payload }),
        })
        expect(parseTailLine('not-json')).toEqual({ kind: 'skip', error: 'record did not parse' })
        pump.push({ kind: 'point', step: Number.NaN, metric: 'loss', value: 1 })
        await vi.advanceTimersByTimeAsync(20)
        expect(frames.at(-1)?.payload).toMatchObject({ lastError: 'record did not parse' })
        expect(pump.push({ kind: 'fatal', message: 'wandb is not available' })).toBe('stop')
        expect(frames.at(-1)).toEqual({
            event: 'training:error',
            payload: { run: 'exp-1', machineId: 'gpu', message: 'wandb is not available' },
        })
        pump.stop()
    })
})

describe('startTrainingTail', () => {
    it('does not spawn for a directory that is not a wandb run', async () => {
        let spawned = false
        const frames: TrainingErrorPayload[] = []
        startTrainingTail({
            run: 'exp-1',
            runDir: '/tmp/not-a-run',
            machineId: 'gpu',
            emit: (_event, payload) => frames.push(payload as TrainingErrorPayload),
            spawnPython: () => {
                spawned = true
                throw new Error('should not spawn')
            },
        })
        await Promise.resolve()
        expect(spawned).toBe(false)
        expect(frames).toEqual([{ run: 'exp-1', machineId: 'gpu', message: 'cannot read this run' }])
        expect(frames[0]?.message).not.toContain('/tmp')
    })

    it('reads batched points from the spawned reader', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-wandb-'))
        const runDir = join(root, 'wandb', 'offline-run-1')
        mkdirSync(runDir, { recursive: true })
        writeFileSync(join(runDir, 'run-1.wandb'), '')
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const child = new EventEmitter() as ChildProcessWithoutNullStreams
        child.stdout = stdout
        child.stderr = stderr
        child.kill = () => true
        const frames: { event: TrainingFrameEvent; payload: TrainingHistoryPayload }[] = []
        const { promise, resolve } = Promise.withResolvers<void>()
        try {
            startTrainingTail({
                run: 'exp-1',
                runDir,
                machineId: 'gpu',
                batchMs: 0,
                emit: (event, payload) => {
                    frames.push({ event, payload: payload as TrainingHistoryPayload })
                    resolve()
                },
                spawnPython: (_script, file) => {
                    expect(file.endsWith(join('wandb', 'offline-run-1', 'run-1.wandb'))).toBe(true)
                    queueMicrotask(() => {
                        stdout.write(`${JSON.stringify({ kind: 'point', step: 1, metric: 'loss', value: 0.3 })}\n`)
                    })
                    return child
                },
            })
            await promise
            expect(frames[0]).toMatchObject({
                event: 'training:history',
                payload: { reset: true, batch: [{ step: 1, metric: 'loss', value: 0.3 }] },
            })
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })
})

describe('attachTrainingHandlers', () => {
    it('ignores a subscribe for a different machine', () => {
        const listeners = new Map<string, (data?: unknown) => void>()
        const emitted: unknown[] = []
        attachTrainingHandlers({
            on: (event, handler) => listeners.set(event, handler),
            emit: (event, payload) => emitted.push({ event, payload }),
        }, 'gpu', () => {
            throw new Error('should not start')
        })
        listeners.get('training:subscribe')?.({ run: 'exp-1', runDir: '/data/wandb/run-1', machineId: 'other' })
        expect(emitted).toEqual([])
    })
})

describe('wandb reader script', () => {
    it('fails closed when wandb is not installed', async () => {
        const child = spawn('python3', ['-c', READ_WANDB_SCRIPT, '/no/such.wandb'], { stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        const { promise, resolve } = Promise.withResolvers<number | null>()
        child.on('exit', resolve)
        const code = await promise
        const line = JSON.parse(Buffer.concat(chunks).toString('utf8').trim()) as { kind: string; message: string }
        expect(code).toBe(0)
        expect(line).toEqual({ kind: 'fatal', message: 'wandb is not available' })
    })
})
