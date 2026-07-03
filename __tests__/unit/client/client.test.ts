import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { createMockServer, type MockServer } from '../../../src/mock-server/server.js';
import { createApiClient, type ApiClient } from '../../../src/client/client.js';
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
