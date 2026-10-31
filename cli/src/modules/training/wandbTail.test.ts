import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

    it('sends a long history as several frames without dropping points', () => {
        const frames: TrainingHistoryPayload[] = []
        const pump = createTrainingPump({
            run: 'exp-1',
            machineId: 'gpu',
            emit: (event, payload) => {
                expect(event).toBe('training:history')
                frames.push(payload as TrainingHistoryPayload)
            },
        })
        for (let step = 0; step < 4500; step += 1) {
            pump.push({ kind: 'point', step, metric: 'loss', value: step / 10 })
        }
        expect(pump.push({ kind: 'exit' })).toBe('stop')
        const batches = frames.map((frame) => frame.batch ?? [])
        expect(frames.length).toBeGreaterThan(1)
        expect(batches.every((batch) => batch.length <= 2000)).toBe(true)
        expect(batches.reduce((sum, batch) => sum + batch.length, 0)).toBe(4500)
        expect(frames[0]?.reset).toBe(true)
        expect(frames.slice(1).every((frame) => !('reset' in frame))).toBe(true)
        expect(frames.at(-1)?.finished).toBe(true)
        expect(batches.flat().map((point) => point.step)).toEqual(Array.from({ length: 4500 }, (_, step) => step))
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
        let resolveFrame: () => void = () => {}
        const promise = new Promise<void>((resolve) => {
            resolveFrame = resolve
        })
        try {
            startTrainingTail({
                run: 'exp-1',
                runDir,
                machineId: 'gpu',
                batchMs: 0,
                emit: (event, payload) => {
                    frames.push({ event, payload: payload as TrainingHistoryPayload })
                    resolveFrame()
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
        }, 'gpu', {
            start: () => {
                throw new Error('should not start')
            },
        })
        listeners.get('training:subscribe')?.({ run: 'exp-1', runDir: '/data/wandb/run-1', machineId: 'other' })
        expect(emitted).toEqual([])
    })
})

describe('wandb reader script', () => {
    const writer = String.raw`
import json, struct, sys, zlib
BLOCK = 32768
FULL, FIRST, MIDDLE, LAST = 1, 2, 3, 4

def varint(number):
    out = bytearray()
    while True:
        byte = number & 0x7f
        number >>= 7
        out.append(byte | 0x80 if number else byte)
        if not number:
            return bytes(out)

def field_bytes(field, payload):
    return varint((field << 3) | 2) + varint(len(payload)) + payload

def field_str(field, text):
    return field_bytes(field, text.encode())

def history_item(key=None, nested=(), value=None, pad=0):
    body = b""
    if key is not None:
        body += field_str(1, key)
    for part in nested:
        body += field_str(2, part)
    if value is not None:
        body += field_str(16, json.dumps(value))
    if pad:
        body += field_bytes(3, b"x" * pad)
    return body

def history(items, step=None):
    body = b"".join(field_bytes(1, item) for item in items)
    if step is not None:
        body += field_bytes(2, varint((1 << 3) | 0) + varint(step))
    return field_bytes(2, body)

def write_record(buf, index, payload, kind):
    checksum = zlib.crc32(payload, zlib.crc32(bytes([kind])) & 0xFFFFFFFF) & 0xFFFFFFFF
    buf += struct.pack("<IHB", checksum, len(payload), kind)
    buf += payload
    return index + 7 + len(payload), buf

def write_payload(buf, index, payload):
    space = BLOCK - (index % BLOCK)
    if space < 7:
        buf += b"\x00" * space
        index += space
        space = BLOCK
    if len(payload) + 7 <= space:
        return write_record(buf, index, payload, FULL)
    room = space - 7
    index, buf = write_record(buf, index, payload[:room], FIRST)
    used = room
    left = len(payload) - used
    while left > BLOCK - 7:
        index, buf = write_record(buf, index, payload[used:used + BLOCK - 7], MIDDLE)
        used += BLOCK - 7
        left -= BLOCK - 7
    return write_record(buf, index, payload[used:], LAST)

def write_file(path, payloads):
    buf = struct.pack("<4sHB", b":W&B", 0xBEE1, 0)
    index = 7
    for payload in payloads:
        index, buf = write_payload(buf, index, payload)
    with open(path, "wb") as handle:
        handle.write(buf)

mode, path = sys.argv[1], sys.argv[2]
exit_record = field_bytes(18, b"")
if mode == "legacy":
    payloads = [history([history_item("_step", value=1), history_item("loss", value=0.25)]), exit_record]
elif mode == "nested":
    payloads = [history([history_item(nested=("train", "loss"), value=0.5)], step=3), exit_record]
elif mode == "split":
    payloads = [history([history_item("loss", value=0.75, pad=40000)], step=4), exit_record]
elif mode == "span":
    buf = struct.pack("<4sHB", b":W&B", 0xBEE1, 0)
    buf += struct.pack("<IHB", 0, 40000, FULL)
    buf += b"\x00" * (BLOCK - len(buf))
    index = BLOCK
    for payload in (history([history_item("loss", value=0.1)], step=8), exit_record):
        index, buf = write_payload(buf, index, payload)
    with open(path, "wb") as handle:
        handle.write(buf)
    raise SystemExit(0)
elif mode == "dense":
    payloads = [history([history_item("loss", value=step / 10)], step=step) for step in range(4000)]
    payloads.append(exit_record)
else:
    raise SystemExit(2)
write_file(path, payloads)
`

    async function readFile(file: string): Promise<{ code: number | null; lines: { kind: string; step?: number; metric?: string; value?: number; message?: string }[] }> {
        const child = spawn('python3', ['-c', READ_WANDB_SCRIPT, file], { stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        const code = await new Promise<number | null>((resolve) => {
            const timer = setTimeout(() => { child.kill(); resolve(null) }, 20000)
            child.on('exit', (status) => { clearTimeout(timer); resolve(status) })
        })
        const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string })
        return { code, lines }
    }

    async function writeRun(dir: string, mode: string): Promise<string> {
        const file = join(dir, 'run.wandb')
        const child = spawn('python3', ['-c', writer, mode, file], { stdio: 'ignore' })
        const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
        expect(code).toBe(0)
        return file
    }

    it('does not import wandb', () => {
        expect(READ_WANDB_SCRIPT).not.toContain('import wandb')
        expect(READ_WANDB_SCRIPT).not.toContain('wandb.sdk')
    })

    it('reads a legacy key record and a nested step record', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wandb-read-'))
        try {
            const legacy = await readFile(await writeRun(dir, 'legacy'))
            expect(legacy.code).toBe(0)
            expect(legacy.lines).toEqual([
                { kind: 'point', step: 1, metric: 'loss', value: 0.25 },
                { kind: 'exit' },
            ])
            const nested = await readFile(await writeRun(dir, 'nested'))
            expect(nested.code).toBe(0)
            expect(nested.lines).toEqual([
                { kind: 'point', step: 3, metric: 'train/loss', value: 0.5 },
                { kind: 'exit' },
            ])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('reads a record split across a leveldb block', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wandb-split-'))
        try {
            const split = await readFile(await writeRun(dir, 'split'))
            expect(split.code).toBe(0)
            expect(split.lines).toEqual([
                { kind: 'point', step: 4, metric: 'loss', value: 0.75 },
                { kind: 'exit' },
            ])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('waits while the header is still short', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wandb-short-'))
        const file = join(dir, 'run.wandb')
        writeFileSync(file, Buffer.alloc(0))
        const child = spawn('python3', ['-c', READ_WANDB_SCRIPT, file], { stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        try {
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect(Buffer.concat(chunks).toString('utf8')).toBe('')
            writeFileSync(file, Buffer.from(':W&'))
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect(Buffer.concat(chunks).toString('utf8')).toBe('')
            const complete = await writeRun(dir, 'legacy')
            writeFileSync(file, readFileSync(complete))
            const code = await new Promise<number | null>((resolve) => {
                const timer = setTimeout(() => { child.kill(); resolve(null) }, 3000)
                child.on('exit', (status) => { clearTimeout(timer); resolve(status) })
            })
            const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string })
            expect(code).toBe(0)
            expect(lines).toEqual([
                { kind: 'point', step: 1, metric: 'loss', value: 0.25 },
                { kind: 'exit' },
            ])
        } finally {
            child.kill()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('skips a record that does not fit in its block once', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wandb-span-'))
        try {
            const span = await readFile(await writeRun(dir, 'span'))
            expect(span.code).toBe(0)
            expect(span.lines).toEqual([
                { kind: 'skip', error: 'record did not parse' },
                { kind: 'point', step: 8, metric: 'loss', value: 0.1 },
                { kind: 'exit' },
            ])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('keeps later points and the exit record after one flipped byte', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wandb-flip-'))
        try {
            const file = await writeRun(dir, 'dense')
            const bytes = readFileSync(file)
            const total = 4000
            const pointsPerBlock = Math.ceil(32768 / (bytes.length / total))
            expect(bytes.length).toBeGreaterThan(80_000)
            bytes[40_000] ^= 0xff
            writeFileSync(file, bytes)
            const flipped = await readFile(file)
            const points = flipped.lines.filter((line) => line.kind === 'point')
            const skips = flipped.lines.filter((line) => line.kind === 'skip')
            expect(flipped.code).toBe(0)
            expect(flipped.lines.at(-1)?.kind).toBe('exit')
            expect(skips).toHaveLength(1)
            expect(points.length).toBeGreaterThanOrEqual(total - pointsPerBlock)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    it('reports an unreadable file instead of a missing wandb package', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wandb-bad-'))
        const file = join(dir, 'broken.wandb')
        writeFileSync(file, 'not a wandb file')
        try {
            const broken = await readFile(file)
            expect(broken.code).toBe(0)
            expect(broken.lines).toEqual([{ kind: 'fatal', message: 'cannot read this run' }])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
