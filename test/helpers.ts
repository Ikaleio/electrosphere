import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry } from '../src/backends/types.ts';
import { SandboxService } from '../src/domain/sandbox-service.ts';
import { SessionManager } from '../src/domain/session-manager.ts';
import { TurnService } from '../src/domain/turn-service.ts';
import { Repository } from '../src/storage/repository.ts';
import { LocalArtifactStore } from '../src/storage/artifacts.ts';
import { openStorage, type Storage } from '../src/storage/sqlite.ts';
import { FakeBackend } from './fake-backend.ts';

export interface TestStack {
  root: string;
  storage: Storage;
  repository: Repository;
  docker: FakeBackend;
  firecracker: FakeBackend;
  backends: BackendRegistry;
  service: SandboxService;
  sessions: SessionManager;
  turns: TurnService;
  artifactStore: LocalArtifactStore;
  authToken: string;
  close(): Promise<void>;
}

export async function createTestStack(): Promise<TestStack> {
  const root = await mkdtemp(join(tmpdir(), 'electrosphere-test-'));
  const storage = await openStorage(root);
  const repository = new Repository(storage.db);
  const docker = new FakeBackend('docker');
  const firecracker = new FakeBackend('firecracker');
  const backends = new BackendRegistry(docker, firecracker);
  const service = new SandboxService(root, repository, backends);
  await service.initialize();
  const sessions = new SessionManager(service, 1_048_576);
  const artifactStore = new LocalArtifactStore(join(root, 'artifacts'), repository);
  const turns = new TurnService(repository, service, sessions, 'docker');
  return {
    root,
    storage,
    repository,
    docker,
    firecracker,
    backends,
    service,
    sessions,
    turns,
    artifactStore,
    authToken: 'test-token',
    async close() {
      await turns.close();
      await sessions.close();
      await service.close();
      storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
