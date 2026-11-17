import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree } from './worktree';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv
  }).trim();
}

function commit(repo: string, file: string, contents: string, message: string): string {
  writeFileSync(join(repo, file), contents);
  git(repo, ['add', file]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

describe('createWorktree start ref', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hapi-worktree-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a new hapi branch at the selected commit without moving the checkout', async () => {
    const first = commit(repo, 'README', 'one\n', 'first');
    const second = commit(repo, 'README', 'two\n', 'second');
    git(repo, ['branch', 'feature', first]);

    const result = await createWorktree({
      basePath: repo,
      nameHint: 'new-feature',
      startRef: 'feature'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.info.branch).toBe('hapi-new-feature');
    expect(git(result.info.worktreePath, ['rev-parse', 'HEAD'])).toBe(first);
    expect(git(result.info.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('hapi-new-feature');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(second);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['rev-parse', 'feature'])).toBe(first);
  });

  it('accepts a full commit sha', async () => {
    const first = commit(repo, 'README', 'one\n', 'first');
    commit(repo, 'README', 'two\n', 'second');

    const result = await createWorktree({ basePath: repo, startRef: first });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git(result.info.worktreePath, ['rev-parse', 'HEAD'])).toBe(first);
  });

  it('leaves an existing worktree and its branch untouched', async () => {
    const first = commit(repo, 'README', 'one\n', 'first');
    commit(repo, 'README', 'two\n', 'second');
    const linked = join(root, 'linked-feature');
    git(repo, ['worktree', 'add', '-b', 'feature', linked, first]);
    writeFileSync(join(linked, 'local.txt'), 'uncommitted\n');

    const result = await createWorktree({
      basePath: repo,
      nameHint: 'from-feature',
      startRef: 'feature'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git(result.info.worktreePath, ['rev-parse', 'HEAD'])).toBe(first);
    expect(git(linked, ['rev-parse', 'HEAD'])).toBe(first);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['rev-parse', 'feature'])).toBe(first);
    expect(existsSync(join(linked, 'local.txt'))).toBe(true);
  });

  it('rejects an unknown ref without creating anything', async () => {
    commit(repo, 'README', 'one\n', 'first');

    const result = await createWorktree({
      basePath: repo,
      nameHint: 'missing',
      startRef: 'does-not-exist'
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('does-not-exist');
    expect(existsSync(join(root, 'repo-worktrees'))).toBe(false);
  });

  it('rejects option-shaped refs without invoking git with them', async () => {
    commit(repo, 'README', 'one\n', 'first');

    const result = await createWorktree({
      basePath: repo,
      nameHint: 'option-shaped',
      startRef: '--upload-pack=evil'
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Invalid Git start ref');
    expect(existsSync(join(root, 'repo-worktrees'))).toBe(false);
  });
});
