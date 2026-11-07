import { describe, expect, it } from 'vitest';
import { ReasoningProcessor, type ReasoningOutput } from './reasoningProcessor';

describe('ReasoningProcessor', () => {
    it('streams untitled reasoning deltas with a stable id and settles on complete()', () => {
        let now = 1_000;
        const emitted: ReasoningOutput[] = [];
        const processor = new ReasoningProcessor(
            (msg) => emitted.push(msg),
            {
                streamUntitledDeltas: true,
                snapshotIntervalMs: 40,
                now: () => now
            }
        );

        processor.processDelta('First thought');
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
            type: 'reasoning',
            message: 'First thought',
            streamSnapshot: true,
            live: true
        });
        const streamId = emitted[0].id;

        now += 20;
        processor.processDelta(' and second');
        expect(emitted).toHaveLength(1);

        now += 25;
        processor.processDelta(' and third');
        expect(emitted).toHaveLength(2);
        expect(emitted[1]).toEqual({
            type: 'reasoning',
            message: 'First thought and second and third',
            id: streamId,
            streamSnapshot: true,
            live: true
        });

        processor.complete('First thought and second and third');
        expect(emitted).toHaveLength(3);
        expect(emitted[2]).toEqual({
            type: 'reasoning',
            message: 'First thought and second and third',
            id: streamId,
            streamSnapshot: true
        });
    });

    it('keeps titled **[Title]** reasoning on the CodexReasoning tool-call path without untitled live snapshots', () => {
        const emitted: ReasoningOutput[] = [];
        const processor = new ReasoningProcessor(
            (msg) => emitted.push(msg),
            { streamUntitledDeltas: true, snapshotIntervalMs: 40 }
        );
        processor.processDelta('**Inspecting files');
        processor.processDelta('** Looking at src');
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
            type: 'tool-call',
            name: 'CodexReasoning',
            input: { title: 'Inspecting files' }
        });

        processor.complete('**Inspecting files** Looking at src/index.ts');
        expect(emitted).toHaveLength(2);
        expect(emitted[1]).toMatchObject({
            type: 'tool-call-result',
            output: {
                content: 'Looking at src/index.ts',
                status: 'completed'
            }
        });
    });
});
