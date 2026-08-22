import { afterEach, describe, expect, test } from 'bun:test';
import { ServiceError } from '../src/domain/errors.ts';
import { createTestStack, type TestStack } from './helpers.ts';

const stacks: TestStack[] = [];

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
});

async function instantStack() {
  const current = await createTestStack();
  stacks.push(current);
  const turn = await current.turns.start({ threadId: crypto.randomUUID(), turnId: 'turn-1', mode: 'instant' });
  return { current, instant: { instantId: turn.instanceId! } };
}

describe('SessionManager', () => {
  test('returns running then completes through poll', async () => {
    const { current, instant } = await instantStack();
    const started = await current.sessions.exec({
      instanceId: instant.instantId,
      command: 'sleep 0.2; printf done',
      yieldTimeMs: 10,
      timeoutMs: 0,
    });
    expect(started.status).toBe('running');
    expect(started.session_id).toBeDefined();
    const completed = await current.sessions.poll({ instanceId: instant.instantId, sessionId: started.session_id!, yieldTimeMs: 1000 });
    expect(completed).toMatchObject({ status: 'completed', exit_code: 0, output: 'done' });
  });

  test('writes to TTY sessions and rejects ordinary non-TTY writes', async () => {
    const { current, instant } = await instantStack();
    const tty = await current.sessions.exec({
      instanceId: instant.instantId,
      command: 'printf ready; read x; printf "$x"',
      tty: true,
      yieldTimeMs: 30,
      timeoutMs: 0,
    });
    expect(tty.status).toBe('running');
    const written = await current.sessions.write({ instanceId: instant.instantId, sessionId: tty.session_id!, chars: 'input\n', yieldTimeMs: 1000 });
    expect(written.status).toBe('completed');
    expect(written.output).toContain('input');

    const plain = await current.sessions.exec({
      instanceId: instant.instantId,
      command: 'sleep 5',
      yieldTimeMs: 10,
      timeoutMs: 0,
    });
    await expect(current.sessions.write({ instanceId: instant.instantId, sessionId: plain.session_id!, chars: 'text', yieldTimeMs: 10 })).rejects.toMatchObject({
      code: 'SESSION_STDIN_CLOSED',
    });
    const interrupted = await current.sessions.write({ instanceId: instant.instantId, sessionId: plain.session_id!, chars: '\u0003', yieldTimeMs: 1000 });
    expect(['canceled', 'failed']).toContain(interrupted.status);
  });

  test('kills a running session without exposing a different session', async () => {
    const { current, instant } = await instantStack();
    const started = await current.sessions.exec({ instanceId: instant.instantId, command: 'sleep 5', yieldTimeMs: 10, timeoutMs: 0 });
    const killed = await current.sessions.kill({ instanceId: instant.instantId, sessionId: started.session_id! });
    expect(killed.status).toBe('killed');
    await expect(current.sessions.poll({ instanceId: instant.instantId, sessionId: crypto.randomUUID(), yieldTimeMs: 0 })).rejects.toBeInstanceOf(ServiceError);
  });

  test('caps returned output while draining the command to completion', async () => {
    const { current, instant } = await instantStack();
    const result = await current.sessions.exec({
      instanceId: instant.instantId,
      command: 'i=0; while [ "$i" -lt 2000 ]; do printf x; i=$((i+1)); done; printf TAIL',
      yieldTimeMs: 1000,
      timeoutMs: 0,
      maxOutputTokens: 64,
    });
    expect(result.status).toBe('completed');
    expect(result.truncated).toBe(true);
    expect(result.output_omitted_bytes).toBeGreaterThan(0);
    expect(result.output).toContain('TAIL');
  });

  test('finish escalates an ignored SIGTERM to SIGKILL before snapshot', async () => {
    const current = await createTestStack();
    stacks.push(current);
    const turn = await current.turns.start({ threadId: 'term-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    const started = await current.sessions.exec({
      instanceId: turn.instanceId!,
      command: "trap '' TERM; while :; do sleep 1; done",
      yieldTimeMs: 10,
      timeoutMs: 0,
    });
    expect(started.status).toBe('running');
    // This exercises real OS signal delivery; fake timers cannot advance process-group termination.
    await current.turns.finish({ threadId: 'term-thread', turnId: 'turn-1' });
    expect(current.docker.snapshotCount).toBe(1);
    const execution = [...current.docker.executions.values()][0];
    expect(execution?.state).toBe('CANCELED');
  });
});
