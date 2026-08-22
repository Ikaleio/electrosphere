import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BackendRegistry } from '../backends/types.ts';
import { DockerBackend } from '../backends/docker.ts';
import { FirecrackerBackend } from '../backends/firecracker.ts';
import { RecoveryManager } from '../domain/recovery.ts';
import { SandboxService } from '../domain/sandbox-service.ts';
import { SessionManager } from '../domain/session-manager.ts';
import { TurnService } from '../domain/turn-service.ts';
import { LocalArtifactStore } from '../storage/artifacts.ts';
import { Repository } from '../storage/repository.ts';
import { openStorage } from '../storage/sqlite.ts';
import { loadConfig } from './config.ts';
import { createMcpHonoApp } from './http.ts';

export interface RunningDaemon {
  host: string;
  port: number;
  stop(): Promise<void>;
}

export async function startDaemon(): Promise<RunningDaemon> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const storage = await openStorage(config.dataDir);
  const docker = new DockerBackend(config);
  const firecracker = new FirecrackerBackend(config);
  const backends = new BackendRegistry(docker, firecracker);
  const probes = await backends.preflight();
  const repository = new Repository(storage.db);
  const artifactStore = new LocalArtifactStore(join(config.dataDir, 'artifacts'), repository);
  const service = new SandboxService(config.dataDir, repository, backends);
  await service.initialize();
  const recovery = new RecoveryManager(config.dataDir, repository, backends);
  await recovery.recover();
  const sessions = new SessionManager(service, config.maxOutputBytes);
  const turns = new TurnService(repository, service, sessions, config.defaultBackend);
  const { app, handler } = createMcpHonoApp({
    host: config.host,
    service,
    sessions,
    turns,
    artifactStore,
    ...(config.authToken ? { authToken: config.authToken } : {}),
    backends,
    storageReady: true,
    probes,
  });
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
  });
  let stopping: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      server.stop(true);
      const failures: unknown[] = [];
      try {
        await turns.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await handler.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await sessions.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await service.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await recovery.gc();
      } catch (error) {
        failures.push(error);
      }
      storage.close();
      if (failures.length > 0) throw new AggregateError(failures, 'Daemon shutdown failed');
    })();
    return stopping;
  };
  const onSignal = (): void => {
    void stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { host: config.host, port: server.port ?? config.port, stop };
}

if (import.meta.main) {
  startDaemon().then((daemon) => {
    console.log(`electrosphere listening on http://${daemon.host}:${daemon.port}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
