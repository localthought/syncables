# syncables

Reads an OpenAPI document and gives you:

- a **mock API server** that implements it, backed by a real (in-memory)
  CRUD store per resource, seeded with fake data generated from the
  document's schemas;
- an **API client** that talks to any server implementing that OpenAPI
  document and keeps a local copy of each resource collection in sync.

## Usage

```sh
pnpm install
pnpm build
pnpm test
```

```ts
import { loadOpenApiDocument, createMockServer, createApiClient } from 'syncables';

const document = await loadOpenApiDocument('./petstore.yaml');

const server = createMockServer(document);
const { url } = await server.listen();

const client = createApiClient(document, { baseUrl: url });
await client.sync(); // pulls every discovered resource collection into local storage

const pets = await client.list('/pets');
```

A "resource" is any pair of an OpenAPI collection path and its matching
item path, e.g. `/pets` and `/pets/{petId}`. Paths without that pairing
(health checks, one-off actions, etc.) are served from their documented
examples/schemas but aren't treated as syncable resources.

## Keeping in sync

`sync()` is safe to call on a timer: it conditionally re-fetches using
`ETag`/`Last-Modified` (or a fallback comparison against the previous sync
when a server doesn't support conditional requests) and only touches local
storage for items that actually changed.

```ts
const handle = client.startPolling({
  intervalMs: 30_000,
  onSync: (result) => console.log('changed:', result.changed),
  onError: (error) => console.error('sync failed:', error),
});

// later
handle.stop();
```

## Writing

`create`/`update`/`remove` are local-first: they update local storage
immediately and return, then apply themselves against the server in the
background, retrying on failure until they succeed.

```ts
const pet = await client.create('/pets', { name: 'Milo', tag: 'cat' });
// `pet` is already in local storage — the POST to the server is still
// happening (and retrying, if needed) in the background.

client.pendingWrites('/pets'); // writes not yet confirmed by the server
```

