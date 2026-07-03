import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { createMockServer, type MockServer } from '../../../src/mock-server/server.js';
import {
  createApiClient,
  type ApiClient,
  type SyncResult,
} from '../../../src/client/client.js';
import { petsDocument } from '../../fixtures/pets.js';

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
