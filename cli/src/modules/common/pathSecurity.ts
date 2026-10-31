import { dirname, resolve, sep } from 'path';
import { pathInside, tryRealpath } from './configFilePath';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);
    const denied = {
        valid: false,
        error: `Access denied: Path '${targetPath}' is outside the working directory`,
    };
    if (!lexicalInside(resolvedTarget, resolvedWorkingDir)) return denied;

    const realRoot = tryRealpath(resolvedWorkingDir);
    if (!realRoot) return { valid: true };

    const realTarget = tryRealpath(resolvedTarget);
    if (realTarget) {
        return pathInside(realTarget, realRoot) ? { valid: true } : denied;
    }

    let current = resolvedTarget;
    while (true) {
        const parent = dirname(current);
        if (parent === current) return { valid: true };
        const realParent = tryRealpath(parent);
        if (realParent) {
            return pathInside(realParent, realRoot) ? { valid: true } : denied;
        }
        current = parent;
    }
}

function lexicalInside(target: string, root: string): boolean {
    const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
    const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix);
}
