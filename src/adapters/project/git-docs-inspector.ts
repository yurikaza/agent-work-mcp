import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectSnapshot } from '../../core/model/session.js';
import type { Clock, ProjectInspector } from '../../core/ports.js';
import { systemClock } from '../../core/ports.js';

const run = promisify(execFile);

const ROOT_DOCS = /^(readme|claude|agents|contributing|architecture|roadmap|todo|changelog)(\.[a-z]+)?$/i;
const DOC_DIRS = ['docs', 'doc', '.github'];
const MAX_DOCS = 50;

/**
 * Local, read-only project facts: git branch/head/uncommitted files and the
 * documentation an agent should read first. No network, no GitHub API.
 */
export class GitDocsProjectInspector implements ProjectInspector {
  constructor(private readonly clock: Clock = systemClock) {}

  async inspect(root: string): Promise<ProjectSnapshot> {
    const [git, docs] = await Promise.all([this.git(root), this.docs(root)]);
    return { capturedAt: this.clock.now().toISOString(), root, ...(git ? { git } : {}), docs };
  }

  private async git(root: string): Promise<ProjectSnapshot['git']> {
    const git = async (...args: string[]) => (await run('git', args, { cwd: root, timeout: 5000 })).stdout.trim();
    try {
      await git('rev-parse', '--is-inside-work-tree');
    } catch {
      return undefined;
    }
    const [branch, head, status] = await Promise.all([
      git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => ''),
      git('rev-parse', 'HEAD').catch(() => ''),
      git('status', '--porcelain=v1', '--untracked-files=normal').catch(() => ''),
    ]);
    return {
      ...(branch && branch !== 'HEAD' ? { branch } : {}),
      ...(head ? { head } : {}),
      dirtyFiles: status
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3)),
    };
  }

  private async docs(root: string): Promise<string[]> {
    const found: string[] = [];
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isFile() && ROOT_DOCS.test(e.name)) found.push(e.name);
    for (const dir of DOC_DIRS) {
      await this.walk(root, dir, found, 0);
    }
    return found.sort().slice(0, MAX_DOCS);
  }

  private async walk(root: string, rel: string, found: string[], depth: number): Promise<void> {
    if (depth > 3 || found.length >= MAX_DOCS) return;
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        await this.walk(root, path, found, depth + 1);
      } else if (e.isFile() && /\.(md|mdx|txt|rst|adoc)$/i.test(e.name)) {
        found.push(path);
      }
    }
  }
}
