import './verify-isolate';

import assert from 'node:assert/strict';
import {
  __setSandboxDockerRunnerForTests,
  ensureSandbox,
  reconcileOrphanedSandboxResources,
  removeSandbox,
  sandboxContainerName,
  sandboxStatus,
} from '../lib/agent-sandbox';

type ResourceKind = 'container' | 'network' | 'volume';

interface FakeResource {
  kind: ResourceKind;
  id: string;
  name: string;
  labels: Record<string, string>;
  running?: boolean;
}

interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function result(code = 0, stdout = '', stderr = ''): DockerResult {
  return { code, stdout, stderr, timedOut: false };
}

class FakeDocker {
  available = true;
  resources: FakeResource[] = [];
  removalFailures = new Set<string>();
  calls: string[][] = [];

  add(resource: FakeResource): void {
    this.resources.push(resource);
  }

  removed(id: string): boolean {
    return this.calls.some((args) => args.includes('rm') && args.at(-1) === id);
  }

  private find(kind: ResourceKind, reference: string): FakeResource | undefined {
    return this.resources.find((item) => (
      item.kind === kind && (item.id === reference || item.name === reference)
    ));
  }

  private inspect(resource: FakeResource): DockerResult {
    if (resource.kind === 'container') {
      return result(0, JSON.stringify([{
        Id: resource.id,
        Name: `/${resource.name}`,
        Config: { Image: 'alpine:test', Labels: resource.labels },
        State: { Running: resource.running !== false },
        HostConfig: { Memory: 512 * 1024 * 1024, NanoCpus: 1e9 },
      }]));
    }
    return result(0, JSON.stringify([{
      ...(resource.kind === 'network' ? { Id: resource.id } : {}),
      Name: resource.name,
      Labels: resource.labels,
    }]));
  }

  runner = async (args: string[]): Promise<DockerResult> => {
    this.calls.push([...args]);
    if (args[0] === 'version') {
      return this.available ? result(0, 'test-docker\n') : result(1, '', 'daemon unavailable');
    }

    if (args[0] === 'inspect') {
      const reference = args.at(-1) || '';
      const resource = this.find('container', reference);
      return resource ? this.inspect(resource) : result(1, '', `Error: No such object: ${reference}`);
    }

    const kind = args[0] as ResourceKind;
    if (!['container', 'network', 'volume'].includes(kind)) return result(1, '', 'unsupported command');
    if (args[1] === 'ls') {
      // Deliberately include every resource of this kind. Production Docker
      // applies the label filter; this verifies the code also checks it again.
      return result(0, this.resources.filter((item) => item.kind === kind).map((item) => item.id).join('\n'));
    }
    if (args[1] === 'inspect') {
      const reference = args.at(-1) || '';
      const resource = this.find(kind, reference);
      return resource ? this.inspect(resource) : result(1, '', `Error: No such ${kind}: ${reference}`);
    }
    if (args[1] === 'rm') {
      const reference = args.at(-1) || '';
      const resource = this.find(kind, reference);
      if (!resource) return result(1, '', `Error: No such ${kind}: ${reference}`);
      if (this.removalFailures.has(resource.id)) return result(1, '', 'resource is busy');
      this.resources = this.resources.filter((item) => item !== resource);
      return result(0, resource.id);
    }
    return result(0);
  };
}

async function verifyInventoryAndRetry(): Promise<void> {
  const fake = new FakeDocker();
  fake.add({
    kind: 'container', id: 'container-valid', name: 'valid',
    labels: { 'shiba.sandbox': '1', 'shiba.agent': 'agent-valid' },
  });
  fake.add({
    kind: 'container', id: 'container-orphan', name: 'orphan',
    labels: { 'shiba.sandbox': '1', 'shiba.agent': 'agent-deleted' },
  });
  fake.add({
    kind: 'container', id: 'container-unassigned', name: 'unassigned',
    labels: { 'shiba.sandbox': '1' },
  });
  fake.add({
    kind: 'container', id: 'container-unrelated', name: 'unrelated',
    labels: { 'another.owner': '1', 'shiba.agent': 'agent-deleted' },
  });
  fake.add({
    kind: 'network', id: 'network-orphan', name: 'network-orphan',
    labels: { 'shiba.sandbox': '1', 'shiba.agent': 'agent-deleted' },
  });
  fake.add({
    kind: 'volume', id: 'volume-valid', name: 'volume-valid',
    labels: { 'shiba.sandbox': '1', 'shiba.agent': 'agent-valid' },
  });
  fake.add({
    kind: 'volume', id: 'volume-retry', name: 'volume-retry',
    labels: { 'shiba.sandbox': '1', 'shiba.agent': 'agent-deleted' },
  });
  fake.removalFailures.add('volume-retry');
  __setSandboxDockerRunnerForTests(fake.runner);

  const first = await reconcileOrphanedSandboxResources(['agent-valid']);
  assert.equal(first.status, 'retry_pending');
  assert.equal(first.retryable, true);
  assert.equal(first.removed, 3, 'deleted-agent and malformed owned resources should be removed');
  assert.equal(first.kept, 2, 'resources belonging to a live agent should remain');
  assert.equal(first.ignored, 1, 'a resource without the exact ownership label should be ignored');
  assert.equal(first.retryPending, 1, 'a failed removal should remain visible for retry');
  assert.equal(fake.removed('container-valid'), false);
  assert.equal(fake.removed('volume-valid'), false);
  assert.equal(fake.removed('container-unrelated'), false);

  fake.removalFailures.clear();
  const second = await reconcileOrphanedSandboxResources(new Set(['agent-valid']));
  assert.equal(second.status, 'ok');
  assert.equal(second.removed, 1, 'the next pass should finish previously blocked cleanup');

  const third = await reconcileOrphanedSandboxResources(['agent-valid']);
  assert.equal(third.status, 'ok');
  assert.equal(third.removed, 0, 'a completed cleanup pass should be idempotent');
  assert.equal(third.retryPending, 0);
}

async function verifyUnavailableDockerIsRetryable(): Promise<void> {
  const fake = new FakeDocker();
  fake.available = false;
  __setSandboxDockerRunnerForTests(fake.runner);
  const report = await reconcileOrphanedSandboxResources(['agent-valid']);
  assert.equal(report.dockerAvailable, false);
  assert.equal(report.status, 'retry_pending');
  assert.equal(report.retryable, true);
  assert.equal(report.retryPending, 1);
  assert.equal(fake.calls.some((args) => args.includes('rm')), false);
}

async function verifyNameCollisionsAreNeverMutated(): Promise<void> {
  const fake = new FakeDocker();
  const agentId = 'agent-collision';
  fake.add({
    kind: 'container',
    id: 'unrelated-id',
    name: sandboxContainerName(agentId),
    labels: { 'shiba.sandbox': '1', 'shiba.agent': 'different-agent' },
  });
  __setSandboxDockerRunnerForTests(fake.runner);

  const removal = await removeSandbox(agentId);
  assert.equal(removal.ok, false);
  assert.equal(removal.ownershipConflict, true);
  assert.equal(fake.removed('unrelated-id'), false, 'removeSandbox must not delete a name collision');

  const ensured = await ensureSandbox(agentId);
  assert.equal(ensured.ok, false);
  assert.match(ensured.error || '', /ownership labels/i);
  assert.equal(
    fake.calls.some((args) => ['update', 'start', 'exec', 'run'].includes(args[0])),
    false,
    'ensureSandbox must not update, start, or exec in a name collision',
  );

  const status = await sandboxStatus(agentId);
  assert.equal(status.exists, false);
  assert.match(status.error || '', /not owned/i);
}

async function verifyExactOwnerRemoval(): Promise<void> {
  const fake = new FakeDocker();
  const agentId = 'agent-owned';
  fake.add({
    kind: 'container',
    id: 'owned-id',
    name: sandboxContainerName(agentId),
    labels: { 'shiba.sandbox': '1', 'shiba.agent': agentId },
  });
  __setSandboxDockerRunnerForTests(fake.runner);

  const removal = await removeSandbox(agentId);
  assert.deepEqual(removal, { ok: true, removed: true });
  assert.equal(fake.removed('owned-id'), true);

  const repeated = await removeSandbox(agentId);
  assert.deepEqual(repeated, { ok: true, removed: false });
}

async function main(): Promise<void> {
  try {
    await verifyInventoryAndRetry();
    await verifyUnavailableDockerIsRetryable();
    await verifyNameCollisionsAreNeverMutated();
    await verifyExactOwnerRemoval();
    console.log('Sandbox ownership and orphan reconciliation verification passed');
  } finally {
    __setSandboxDockerRunnerForTests(null);
  }
}

main().catch((error) => {
  console.error('Sandbox integrity verification failed', error);
  process.exitCode = 1;
});
