import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { createMockServer, type MockServer } from '../../../src/mock-server/server.js';
import {
  createApiClient,
  type ApiClient,
  type SyncResult,
} from '../../../src/client/client.js';
import { petsDocument } from '../../fixtures/pets.js';

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('createApiClient', () => {
  let server: MockServer;
  let client: ApiClient;

  beforeAll(async () => {
    const document = await loadOpenApiDocument(petsDocument);
    server = createMockServer(document);
    const info = await server.listen();
    client = createApiClient(document, { baseUrl: info.url });
  });

  afterAll(() => server.close());

  it('discovers the resources described by the document', () => {
    expect(client.resources).toEqual(['/pets']);
  });

  it('syncs the remote collection into local storage', async () => {
    expect(await client.list('/pets')).toEqual([]);

    await client.sync();

    const pets = await client.list('/pets');
    expect(pets.length).toBeGreaterThan(0);
  });

  it('creates a resource remotely and stores it locally', async () => {
    const created = await client.create('/pets', { name: 'Milo', tag: 'cat' });

    const local = await client.get('/pets', created['id'] as string);
    expect(local).toEqual(created);
  });

  it('updates and removes a resource, keeping local storage in sync', async () => {
    const created = await client.create('/pets', { name: 'Buddy', tag: 'dog' });
    const id = created['id'] as string;

    await client.update('/pets', id, { name: 'Buddy Jr', tag: 'dog' });
    const updated = await client.get('/pets', id);
    expect(updated?.['name']).toBe('Buddy Jr');

    await client.remove('/pets', id);
    expect(await client.get('/pets', id)).toBeUndefined();
  });

  it('throws for an unknown resource', async () => {
    await expect(client.list('/unknown')).rejects.toThrow(/Unknown resource/);
  });
});

describe('createApiClient conditional sync', () => {
  let server: MockServer;
  let client: ApiClient;
  let responseStatuses: number[];

  beforeAll(async () => {
    const document = await loadOpenApiDocument(petsDocument);
    server = createMockServer(document);
    const info = await server.listen();
    const trackingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      responseStatuses.push(response.status);
      return response;
    };
    client = createApiClient(document, {
      baseUrl: info.url,
      fetch: trackingFetch,
    });
  });

  afterAll(() => server.close());

  it('only reports a resource as changed the sync it actually changed in', async () => {
    responseStatuses = [];
    const first = await client.sync();
    expect(first.changed).toEqual(['/pets']);

    const second = await client.sync();
    expect(second.changed).toEqual([]);
    // The mock server now honors If-None-Match/If-Modified-Since, so the
    // second, no-op sync gets a 304 instead of a full body.
    expect(responseStatuses).toContain(304);

    await client.create('/pets', { name: 'Whiskers', tag: 'cat' });

    const third = await client.sync();
    expect(third.changed).toEqual(['/pets']);
  });

  it('polls on an interval until stopped', async () => {
    const results: SyncResult[] = [];
    const handle = client.startPolling({
      intervalMs: 20,
      onSync: (result) => results.push(result),
    });

    await new Promise((resolve) => setTimeout(resolve, 90));
    handle.stop();
    // stop() doesn't cancel a sync already in flight when it's called, so
    // give one a moment to land before treating the count as final.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const countAfterStop = results.length;

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(countAfterStop).toBeGreaterThanOrEqual(2);
    expect(results.length).toBe(countAfterStop);
    for (const result of results) {
      expect(Array.isArray(result.changed)).toBe(true);
    }
  });

  it('reports polling errors via onError and keeps polling', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const brokenClient = createApiClient(document, {
      baseUrl: 'http://127.0.0.1:1',
    });
    const errors: unknown[] = [];

    const handle = brokenClient.startPolling({
      intervalMs: 20,
      onError: (error) => errors.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();

    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('createApiClient local-first writes', () => {
  let server: MockServer;
  let baseUrl: string;

  beforeAll(async () => {
    const document = await loadOpenApiDocument(petsDocument);
    server = createMockServer(document);
    const info = await server.listen();
    baseUrl = info.url;
  });

  afterAll(() => server.close());

  it('creates, updates and removes locally without waiting on the network', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    let releaseRequests: (() => void) | undefined;
    const blockedUntilReleased = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const stalledFetch: typeof fetch = async (input, init) => {
      await blockedUntilReleased;
      return fetch(input, init);
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: stalledFetch,
    });

    const created = await client.create('/pets', { name: 'Milo', tag: 'cat' });
    expect(await client.get('/pets', created['id'] as string)).toEqual(created);
    expect(client.pendingWrites('/pets')).toEqual([
      { resource: '/pets', id: created['id'], type: 'create', attempts: 0 },
    ]);

    const id = created['id'] as string;
    const updated = await client.update('/pets', id, { name: 'Milo Jr' });
    expect(updated['name']).toBe('Milo Jr');
    expect(await client.get('/pets', id)).toEqual(updated);

    await client.remove('/pets', id);
    expect(await client.get('/pets', id)).toBeUndefined();

    // All three writes are still stuck behind the same stalled fetch.
    expect(client.pendingWrites('/pets').map((w) => w.type)).toEqual([
      'create',
      'update',
      'delete',
    ]);

    releaseRequests?.();
    await waitUntil(() => client.pendingWrites('/pets').length === 0);
  });

  it('retries a failing write with backoff until it succeeds', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    let putAttempts = 0;
    const flakyFetch: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        putAttempts += 1;
        if (putAttempts < 3) {
          throw new Error('simulated network failure');
        }
      }
      return fetch(input, init);
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: flakyFetch,
      retry: { baseDelayMs: 5, maxDelayMs: 20 },
    });

    await client.sync();
    const [pet] = await client.list('/pets');
    const id = pet?.['id'] as string;

    const before = Date.now();
    await client.update('/pets', id, { name: 'Renamed Fast' });
    expect(Date.now() - before).toBeLessThan(50);

    await waitUntil(() => putAttempts >= 3);
    await waitUntil(() => client.pendingWrites('/pets').length === 0);

    const remote = await fetch(`${baseUrl}/pets/${id}`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(remote['name']).toBe('Renamed Fast');
  });

  it('moves a locally created record onto whatever id the server assigns', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const reassigningFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if ((init?.method ?? 'GET') !== 'POST') {
        return response;
      }
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ...body, id: 'server-assigned-id' }),
        { status: response.status, headers: response.headers },
      );
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: reassigningFetch,
    });

    const created = await client.create('/pets', { name: 'Reassigned', tag: 'cat' });
    const localId = created['id'] as string;

    await waitUntil(() => client.pendingWrites('/pets').length === 0);

    expect(await client.get('/pets', localId)).toBeUndefined();
    const moved = await client.get('/pets', 'server-assigned-id');
    expect(moved?.['name']).toBe('Reassigned');
  });

  it('stops retrying once maxAttempts is reached and surfaces the failure', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const alwaysFailingFetch: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        throw new Error('server unreachable');
      }
      return fetch(input, init);
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: alwaysFailingFetch,
      retry: { baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 },
    });

    await client.sync();
    const [pet] = await client.list('/pets');
    const id = pet?.['id'] as string;

    await client.remove('/pets', id);

    await waitUntil(() => {
      const [pending] = client.pendingWrites('/pets');
      return pending?.attempts === 2;
    });

    const [pending] = client.pendingWrites('/pets');
    expect(pending).toMatchObject({ type: 'delete', attempts: 2 });
    expect(pending?.lastError).toMatch(/server unreachable/);

    // Doesn't keep retrying forever once it's given up.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(client.pendingWrites('/pets')[0]?.attempts).toBe(2);
  });
});
