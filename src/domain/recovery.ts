import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BackendHandle } from '../backends/types.ts';
import type { BackendRegistry } from '../backends/types.ts';
import type { Digest } from './types.ts';
import type { Repository } from '../storage/repository.ts';

export class RecoveryManager {
  constructor(
    private readonly dataDir: string,
    private readonly repository: Repository,
    private readonly backends: BackendRegistry,
  ) {}

  private async cleanupFinishedTurnRuntimes(): Promise<void> {
    for (const turn of this.repository.listTurns(['FINISHED'])) {
      if (turn.mode !== 'durable' || !turn.instanceId) continue;
      const instance = this.repository.getInstance(turn.instanceId);
      if (!instance?.backendHandle || instance.state === 'TERMINATED') continue;
      const handle = JSON.parse(instance.backendHandle) as BackendHandle;
      try {
        await this.backends.get(instance.backend).destroy(handle);
        this.repository.updateInstance(instance.id, { state: 'TERMINATED', backendHandle: null, lastError: null });
      } catch (error) {
        this.repository.updateInstance(instance.id, {
          state: 'LOST',
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async recover(): Promise<void> {
    this.repository.deleteRunningOperations();
    const staging = join(this.dataDir, 'staging');
    const stagingEntries = await readdir(staging, { withFileTypes: true }).catch(() => []);
    for (const entry of stagingEntries) {
      await rm(join(staging, entry.name), { recursive: true, force: true });
    }
    await this.cleanupFinishedTurnRuntimes();
    const interrupted = this.repository.listInstances(['PROVISIONING', 'READY', 'RUNNING', 'COMMITTING', 'TERMINATING']);
    for (const instance of interrupted) {
      let destroyed = false;
      if (instance.backendHandle) {
        const handle = JSON.parse(instance.backendHandle) as BackendHandle;
        destroyed = await this.backends.get(instance.backend).destroy(handle).then(() => true, () => false);
      }
      this.repository.updateInstance(instance.id, {
        state: 'LOST',
        ...(destroyed ? { backendHandle: null } : {}),
        lastError: 'Daemon restarted during active instance state',
      });
    }
    for (const turn of this.repository.listTurns(['STARTING', 'OPEN', 'FINISHING'])) {
      this.repository.updateTurn(turn.threadId, turn.turnId, {
        state: 'FAILED',
        errorJson: JSON.stringify({ code: 'TURN_CLOSED', message: 'Daemon restarted during active turn' }),
        finishedAt: Date.now(),
      });
    }
  }

  async gc(): Promise<{ deletedTrees: number; deletedCommits: number }> {
    await this.cleanupFinishedTurnRuntimes();
    const commits = this.repository.listCommits();
    const byId = new Map(commits.map((commit) => [commit.id, commit]));
    const reachableCommits = new Set<string>();
    const pending = [...this.repository.listGcRoots()];
    while (pending.length > 0) {
      const id = pending.pop();
      if (!id || reachableCommits.has(id)) continue;
      reachableCommits.add(id);
      const commit = byId.get(id);
      if (commit?.parentId) pending.push(commit.parentId);
    }
    const reachableTrees = new Set(
      commits.filter((commit) => reachableCommits.has(commit.id)).map((commit) => commit.treeDigest),
    );
    let deletedTrees = 0;
    const treeDirectory = join(this.dataDir, 'objects', 'trees', 'sha256');
    const trackedTreePaths = new Set(this.repository.listTreeObjects().map((tree) => tree.path));
    for (const entry of await readdir(treeDirectory, { withFileTypes: true }).catch(() => [])) {
      const path = join(treeDirectory, entry.name);
      if (trackedTreePaths.has(path)) continue;
      await rm(path, { recursive: true, force: true });
      deletedTrees += 1;
    }
    for (const tree of this.repository.listTreeObjects()) {
      if (reachableTrees.has(tree.digest)) continue;
      await rm(tree.path, { force: true });
      this.repository.deleteTreeObject(tree.digest as Digest);
      deletedTrees += 1;
    }
    const depthById = new Map<string, number>();
    const depthOf = (id: string): number => {
      const cached = depthById.get(id);
      if (cached !== undefined) return cached;
      let depth = 0;
      let current = byId.get(id)?.parentId;
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        seen.add(current);
        depth += 1;
        current = byId.get(current)?.parentId ?? null;
      }
      depthById.set(id, depth);
      return depth;
    };
    let deletedCommits = 0;
    const unreachable = commits.filter((commit) => !reachableCommits.has(commit.id));
    unreachable.sort((left, right) => depthOf(right.id) - depthOf(left.id));
    for (const commit of unreachable) {
      this.repository.deleteCommit(commit.id as Digest);
      deletedCommits += 1;
    }
    for (const instance of this.repository.listInstances(['TERMINATED', 'FAILED', 'LOST'])) {
      await rm(dirname(instance.workspacePath), { recursive: true, force: true });
    }
    return { deletedTrees, deletedCommits };
  }
}
