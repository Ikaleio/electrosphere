import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry } from '../src/backends/types.ts';
import { DockerBackend } from '../src/backends/docker.ts';
import type { Config } from '../src/daemon/config.ts';
import { SandboxService } from '../src/domain/sandbox-service.ts';
import { SessionManager } from '../src/domain/session-manager.ts';
import { TurnService } from '../src/domain/turn-service.ts';
import { Repository } from '../src/storage/repository.ts';
import { openStorage } from '../src/storage/sqlite.ts';
import { FakeBackend } from './fake-backend.ts';

const runtimeImage = Bun.env.ELECTROSPHERE_RUNTIME_IMAGE;

describe.skipIf(!runtimeImage)('real Docker backend', () => {
  test('executes through the PID1 agent with isolation, sessions, output caps, and commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'electrosphere-docker-'));
    const config: Config = {
      dataDir: root,
      host: '127.0.0.1',
      port: 8787,
      defaultBackend: 'docker',
      dockerSocket: Bun.env.ELECTROSPHERE_DOCKER_SOCKET ?? '/var/run/docker.sock',
      runtimeImage: runtimeImage!,
      maxOutputBytes: 1_048_576,
    };
    const storage = await openStorage(root);
    const repository = new Repository(storage.db);
    const docker = new DockerBackend(config);
    const backends = new BackendRegistry(docker, new FakeBackend('firecracker'));
    const service = new SandboxService(root, repository, backends);
    await service.initialize();
    const sessions = new SessionManager(service, config.maxOutputBytes);
    const turns = new TurnService(repository, service, sessions, 'docker');
    try {
      expect((await docker.preflight()).available).toBe(true);
      const turn = await turns.start({
        threadId: 'docker-thread',
        turnId: 'turn-1',
        mode: 'durable',
        backend: 'docker',
        network: 'none',
        resourceProfile: { memoryMiB: 512, vcpus: 1, diskMiB: 64, pidsMax: 128, timeoutMs: 0 },
      });
      const basic = await sessions.exec({
        instanceId: turn.instanceId!,
        command: 'cat /proc/1/comm; printf "|"; id -u; printf "|"; printf hello > /workspace/a; cat /workspace/a',
        yieldTimeMs: 10_000,
        timeoutMs: 0,
      });
      expect(basic.status).toBe('completed');
      expect(basic.output).toContain('electrosphere-a');
      expect(basic.output).toMatch(/\|1000\n\|hello$/);

      const long = await sessions.exec({
        instanceId: turn.instanceId!,
        command: 'sleep 0.2; printf done',
        yieldTimeMs: 10,
        timeoutMs: 0,
      });
      expect(long.status).toBe('running');
      expect(await sessions.poll({ instanceId: turn.instanceId!, sessionId: long.session_id!, yieldTimeMs: 1000 })).toMatchObject({ status: 'completed', output: 'done' });

      const tty = await sessions.exec({
        instanceId: turn.instanceId!,
        command: 'printf ready; read x; printf "$x"',
        tty: true,
        yieldTimeMs: 50,
        timeoutMs: 0,
      });
      expect(tty.output).toContain('ready');
      expect(await sessions.write({ instanceId: turn.instanceId!, sessionId: tty.session_id!, chars: 'input\n', yieldTimeMs: 1000 })).toMatchObject({ status: 'completed', output: 'input' });

      const isolation = await sessions.exec({
        instanceId: turn.instanceId!,
        command: 'test ! -e /var/run/docker.sock && printf no-socket; printf "|"; (touch /root/x 2>/dev/null || printf readonly-root); printf "|"; (mknod /tmp/dev c 1 3 2>/dev/null || printf no-device); printf "|"; if grep -q "[[:space:]]00000000[[:space:]]" /proc/net/route; then printf default-route; else printf no-route; fi; printf "|"; cat /sys/fs/cgroup/memory.max; printf "|"; cat /sys/fs/cgroup/pids.max',
        yieldTimeMs: 10_000,
        timeoutMs: 0,
      });
      expect(isolation.output.replaceAll('\n', '')).toBe('no-socket|readonly-root|no-device|no-route|536870912|128');

      const capped = await sessions.exec({
        instanceId: turn.instanceId!,
        command: 'yes x | head -c 2097152; printf TAIL',
        yieldTimeMs: 10_000,
        timeoutMs: 0,
        maxOutputTokens: 100,
      });
      expect(capped).toMatchObject({ status: 'completed', truncated: true });
      expect(capped.output_omitted_bytes).toBeGreaterThan(2_000_000);
      expect(capped.output.endsWith('TAIL')).toBe(true);

      const committed = await turns.finish({ threadId: 'docker-thread', turnId: 'turn-1' });
      expect(committed.headCommit).toMatch(/^sha256:[0-9a-f]{64}$/);
      const fullTurn = await turns.start({
        threadId: 'docker-full-thread',
        turnId: 'turn-1',
        mode: 'durable',
        backend: 'docker',
        resourceProfile: { memoryMiB: 512, vcpus: 1, diskMiB: 64, pidsMax: 128, timeoutMs: 0 },
      });
      await expect(sessions.exec({
        instanceId: fullTurn.instanceId!,
        command: 'dd if=/dev/zero of=/workspace/full bs=1M count=80 status=none',
        yieldTimeMs: 10_000,
        timeoutMs: 0,
      })).rejects.toMatchObject({ code: 'STORAGE_EXHAUSTED', status: 507 });
      await turns.finish({ threadId: 'docker-full-thread', turnId: 'turn-1' });
    } finally {
      await turns.close();
      await sessions.close();
      await service.close();
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
