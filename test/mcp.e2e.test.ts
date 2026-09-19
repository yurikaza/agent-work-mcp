import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import { harness, type Harness } from './helpers.js';

let client: Client;
let h: Harness;

async function connect() {
  h = harness();
  const server = createMcpServer(h.o);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
}

afterEach(async () => {
  await client?.close();
});

/** Call a tool and return its structured result; fail loudly on tool errors. */
async function call<T = Record<string, any>>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  expect(r.structuredContent).toBeDefined();
  return r.structuredContent as T;
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  expect(r.isError).toBe(true);
  return (r.content as { text: string }[])[0]!.text;
}

const evidence = { passed: true, checks: [{ name: 'npm test', passed: true }] };

describe('MCP surface', () => {
  it('exposes a small, high-level, annotated tool set with instructions', async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'start_session',
      'list_sessions',
      'get_session',
      'get_phase',
      'pause_session',
      'resume_session',
      'stop_session',
      'get_work_graph',
      'update_work_graph',
      'next_work',
      'report_work',
      'request_decision',
      'get_decisions',
      'record_decision',
      'get_handoff',
      'get_session_report',
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]{1,128}$/);
      expect(t.outputSchema?.type).toBe('object');
      expect(t.annotations?.openWorldHint).toBe(false);
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly.sort()).toEqual(
      ['get_decisions', 'get_handoff', 'get_phase', 'get_session', 'get_session_report', 'get_work_graph', 'list_sessions'].sort(),
    );
    expect(client.getInstructions()).toMatch(/OUTSIDE_MODE/);
  });

  it('maps rule violations to tool errors, not protocol errors', async () => {
    await connect();
    expect(await callError('get_session', { sessionId: 'ses_nope' })).toMatch(/^NOT_FOUND:/);
    expect(await callError('start_session', { mode: 'outside', goal: 'x' })).toMatch(/^BUDGET_REQUIRED:/);
    expect(await callError('start_session', { mode: 'sideways', goal: 'x' })).toMatch(/mode/);
  });
});

describe('end-to-end session lifecycle over MCP', () => {
  it('OUTSIDE run → decision → halt → DESK resolve → resume → complete', async () => {
    await connect();

    // OUTSIDE_MODE: start and analyze
    const started = await call('start_session', {
      mode: 'outside',
      goal: 'Add team invitations',
      exitCriteria: ['Invites can be sent and accepted'],
      budgetMinutes: 180,
      projectRoot: '/tmp/e2e',
    });
    const sessionId = started.session.sessionId as string;
    expect(started.session.state).toBe('analyzing');
    expect((await call('next_work', { sessionId })).action).toBe('plan');

    await call('update_work_graph', {
      sessionId,
      projectContext: { summary: 'Express + Postgres monolith', keyFiles: ['src/app.ts'], commands: { test: 'npm test' } },
      units: [
        { id: 'invite-model', title: 'Invite table + model', estimateMinutes: 30, acceptance: ['migration runs'] },
        { id: 'invite-email', title: 'Send invite email', dependsOn: ['invite-model'], estimateMinutes: 30 },
        { id: 'invite-accept', title: 'Accept endpoint', dependsOn: ['invite-model'], estimateMinutes: 30 },
        { id: 'audit-log', title: 'Audit log for team changes', estimateMinutes: 20 },
      ],
    });

    // Loop: execute → report → next
    let next = await call('next_work', { sessionId });
    expect(next).toMatchObject({ action: 'execute', state: 'running' });
    expect(next.dispatch.assignments[0].unit.id).toBe('invite-model');
    h.clock.advanceMinutes(25);
    const reported = await call('report_work', {
      sessionId,
      unitId: 'invite-model',
      outcome: 'completed',
      summary: 'Migration + model',
      validation: evidence,
      artifacts: ['src/models/invite.ts'],
    });
    expect(reported.guidance).toMatch(/does not end the session/);

    // Mid-run the agent hits a product question. It queues it and keeps going.
    const decision = await call('request_decision', {
      sessionId,
      question: 'Should invites expire?',
      whyItMatters: 'Security posture and support load; changes the accept flow.',
      category: 'product',
      options: [{ id: '7d', label: 'Expire after 7 days' }, { id: 'never', label: 'Never expire' }],
      recommendation: '7d',
      affectedUnitIds: ['invite-accept'],
    });
    expect(decision.decision.independentReadyUnitIds.sort()).toEqual(['audit-log', 'invite-email']);
    expect(
      await callError('record_decision', { sessionId, decisionId: 'dec-1', choice: '7d', decidedBy: 'agent' }),
    ).toMatch(/^DECISION_REQUIRES_HUMAN:/);

    const executed: string[] = [];
    for (;;) {
      next = await call('next_work', { sessionId });
      if (next.action === 'stop') break;
      expect(next.action).toBe('execute');
      for (const a of next.dispatch.assignments) {
        h.clock.advanceMinutes(15);
        await call('report_work', { sessionId, unitId: a.unit.id, outcome: 'completed', summary: 'ok', validation: evidence });
        executed.push(a.unit.id);
      }
    }
    expect(executed).toEqual(['invite-email', 'audit-log', 'validate-1']);
    expect(next).toMatchObject({ stopReason: 'waiting_for_human', state: 'waiting_for_human' });

    // DESK_MODE: pick up from the handoff, no rediscovery needed.
    const listed = await call('list_sessions', { projectRoot: '/tmp/e2e' });
    expect(listed.sessions[0].state).toBe('waiting_for_human');
    const handoffRaw = await client.callTool({ name: 'get_handoff', arguments: { sessionId } });
    const handoffText = (handoffRaw.content as { text: string }[])[0]!.text;
    expect(handoffText).toMatch(/# Handoff: Add team invitations/);
    expect(handoffText).toMatch(/Decide dec-1: Should invites expire\?/);
    const handoff = handoffRaw.structuredContent as Record<string, any>;
    expect(handoff.projectContext.summary).toBe('Express + Postgres monolith');
    expect(handoff.completed.map((u: { id: string }) => u.id)).toEqual(['invite-model', 'invite-email', 'audit-log', 'validate-1']);

    const queue = await call('get_decisions', { sessionId });
    expect(queue.canRecordDecisions).toBe(true);
    const recorded = await call('record_decision', {
      sessionId,
      decisionId: queue.decisions[0].id,
      choice: '7d',
      rationale: 'Limit exposure of leaked links',
      decidedBy: 'Yusuf',
    });
    expect(recorded).toMatchObject({ state: 'resumable', unblockedUnitIds: ['invite-accept'] });

    // Back to autonomy for the rest.
    const resumed = await call('resume_session', { sessionId, mode: 'outside' });
    expect(resumed.session.state).toBe('planning');
    next = await call('next_work', { sessionId });
    expect(next.dispatch.assignments[0].unit.notes.join(' ')).toMatch(/resolved by Yusuf: 7d/);
    await call('report_work', { sessionId, unitId: 'invite-accept', outcome: 'completed', summary: 'ok', validation: evidence });
    next = await call('next_work', { sessionId });
    expect(next.dispatch.assignments[0].unit.id).toBe('validate-2');
    await call('report_work', { sessionId, unitId: 'validate-2', outcome: 'completed', summary: 'all green', validation: evidence });
    next = await call('next_work', { sessionId });
    expect(next).toMatchObject({ action: 'stop', stopReason: 'completed', state: 'completed' });

    const phase = await call('get_phase', { sessionId });
    expect(phase.progress).toMatchObject({ totalUnits: 4, done: 4, percentDone: 100 });
    const report = await call('get_session_report', { sessionId });
    expect(report).toMatchObject({ outcome: 'completed', decisions: { raised: 1, resolved: 1 } });
    expect(report.budget.unusedReason).toMatch(/intentionally left unused/);
    expect(report.runs).toHaveLength(2);
  });
});
