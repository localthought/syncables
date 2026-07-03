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
