import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { validatePath } from './pathSecurity';

describe('validatePath', () => {
    const workingDir = '/home/user/project';

    it('should allow paths within working directory', () => {
        expect(validatePath('/home/user/project/file.txt', workingDir).valid).toBe(true);
        expect(validatePath('file.txt', workingDir).valid).toBe(true);
        expect(validatePath('./src/file.txt', workingDir).valid).toBe(true);
    });

    it('should reject paths outside working directory', () => {
        const result = validatePath('/etc/passwd', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should correctly handle working directory at filesystem root', () => {
        const rootDir = '/'
        expect(validatePath('/etc/passwd', rootDir).valid).toBe(true);
        expect(validatePath('etc/passwd', rootDir).valid).toBe(true);
    });

    it('should not treat sibling directories as inside working directory', () => {
        const result = validatePath('/home/user/project2/file.txt', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir).valid).toBe(true);
        expect(validatePath(workingDir, workingDir).valid).toBe(true);
    });

    it('rejects a symlink inside the working directory whose target is outside it', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-path-security-'));
        const outside = mkdtempSync(join(tmpdir(), 'hapi-path-outside-'));
        try {
            writeFileSync(join(outside, 'secret'), 'nope');
            symlinkSync(join(outside, 'secret'), join(root, 'link'));
            mkdirSync(join(root, 'nested'));
            symlinkSync(outside, join(root, 'nested', 'dir-link'));
            expect(validatePath('link', root).valid).toBe(false);
            expect(validatePath(join('nested', 'dir-link', 'secret'), root).valid).toBe(false);
            expect(validatePath('nested', root).valid).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });
});

