import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionRepository } from '../src/adapters/persistence/file-repository.js';
import { GitDocsProjectInspector } from '../src/adapters/project/git-docs-inspector.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { VERSION } from '../src/version.js';
import { complete, FakeClock, fakeInspector, unit } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-work-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const boot = (clock: FakeClock) =>
  new Orchestrator({
    repository: new FileSessionRepository(join(dir, 'state')),
    clock,
    inspector: fakeInspector,
    defaultProjectRoot: dir,
  });

describe('FileSessionRepository', () => {
  it('state survives a process restart mid-session', async () => {
    const clock = new FakeClock();
    const first = boot(clock);
    const { session } = await first.startSession({ mode: 'outside', goal: 'persist me', budgetMinutes: 120 });
    const sid = session.sessionId;
    expect(sid).toMatch(/^ses_[0-9a-f]{32}$/);
    await first.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b', { dependsOn: ['a'] })] });
    await first.nextWork(sid);
    await first.requestDecision({ sessionId: sid, question: 'q?', whyItMatters: 'w', affectedUnitIds: ['b'] });
    clock.advanceMinutes(10);
    await first.reportWork({ sessionId: sid, unitId: 'a', outcome: 'progress', summary: 'half', checkpoint: 'step 2 of 3' });

    // "Crash": drop the orchestrator, boot a new one on the same directory much later.
    clock.advanceMinutes(180);
    const second = boot(clock);
    const listed = await second.listSessions({});
    expect(listed.sessions.map((s) => [s.sessionId, s.liveness, s.openDecisions])).toEqual([[sid, 'stale', 1]]);

    const resumed = await second.resumeSession({ sessionId: sid });
    expect(resumed).toMatchObject({ recoveredFromInterruption: true, releasedUnitIds: ['a'] });
    expect(resumed.session.budget.usedMinutes).toBe(10);
    expect(resumed.handoff.decisionsNeeded.map((d) => d.id)).toEqual(['dec-1']);
    const next = await second.nextWork(sid);
    expect(next.dispatch?.assignments[0]?.unit).toMatchObject({ id: 'a', checkpoint: 'step 2 of 3' });
    await complete(second, sid, 'a');
    expect((await second.getSession(sid)).session.counts.done).toBe(1);
  });

  it('keeps its state out of git and rejects stale writers', async () => {
    const repo = new FileSessionRepository(join(dir, 'state'));
    const o = new Orchestrator({ repository: repo, defaultProjectRoot: dir });
    const { session } = await o.startSession({ mode: 'desk', goal: 'g' });
    expect(await readFile(join(dir, 'state', '.gitignore'), 'utf8')).toMatch(/^\*$/m);

    const a = (await repo.load(session.sessionId))!;
    const b = (await repo.load(session.sessionId))!;
    await repo.save(a, a.revision);
    await expect(repo.save(b, b.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repo.load('../../etc/passwd')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GitDocsProjectInspector', () => {
  it('reports branch, uncommitted files and docs', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    await writeFile(join(dir, 'README.md'), '# x\n');
    await mkdir(join(dir, 'docs', 'adr'), { recursive: true });
    await writeFile(join(dir, 'docs', 'adr', '0001.md'), 'adr\n');
    await writeFile(join(dir, 'CLAUDE.md'), 'rules\n');

    const snap = await new GitDocsProjectInspector().inspect(dir);
    expect(snap.git?.branch).toBe('main');
    expect(snap.git?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.git?.dirtyFiles.sort()).toEqual(['CLAUDE.md', 'README.md', 'docs/']);
    expect(snap.docs).toEqual(['CLAUDE.md', 'README.md', 'docs/adr/0001.md']);
  });

  it('works outside a git repository', async () => {
    const snap = await new GitDocsProjectInspector().inspect(dir);
    expect(snap.git).toBeUndefined();
    expect(snap.docs).toEqual([]);
  });
});

describe('package metadata', () => {
  it('VERSION matches package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
