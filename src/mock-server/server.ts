import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { generateFromSchema } from '../fake-data/generate.js';
import {
  discoverResources,
  type ResourceRoute,
} from '../resources/discover.js';
import type {
  OpenApiDocument,
  OperationObject,
  SchemaObject,
} from '../openapi/types.js';
import { findRoute } from './router.js';
import { ResourceStore } from './store.js';

export interface MockServer {
  listen(port?: number): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

const SEED_COUNT = 3;

export function createMockServer(document: OpenApiDocument): MockServer {
  const paths = document.paths as unknown as Record<
    string,
    Record<string, OperationObject | undefined>
  >;
  const resources = discoverResources(paths);
  const store = new ResourceStore();
  const server: Server = createServer((req, res) => {
    handleRequest(req, res, paths, resources, store).catch((error: unknown) => {
      sendJson(res, 500, { error: String(error) });
    });
  });

  return {
    listen(port = 0): Promise<{ port: number; url: string }> {
      return new Promise((resolve) => {
        server.listen(port, () => {
          const address = server.address();
          const actualPort =
            typeof address === 'object' && address ? address.port : port;
          resolve({ port: actualPort, url: `http://127.0.0.1:${actualPort}` });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  paths: Record<string, Record<string, OperationObject | undefined>>,
  resources: ResourceRoute[],
  store: ResourceStore,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toLowerCase();
  const match = findRoute(Object.keys(paths), url.pathname);

  if (!match) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  const operation = paths[match.template]?.[method];
  if (!operation) {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const body =
    method === 'post' || method === 'put' || method === 'patch'
      ? await readJsonBody(req)
      : undefined;

  const resource = resources.find(
    (route) =>
      route.collectionPath === match.template ||
      route.itemPath === match.template,
  );

  if (resource?.itemPath === match.template) {
    const id = match.params[resource.itemParam] ?? '';
    handleItemRequest(method, id, resource, store, body, res);
    return;
  }

  if (resource?.collectionPath === match.template) {
    handleCollectionRequest(method, resource, operation, store, body, res);
    return;
  }

  respondWithExample(operation, res);
}

function handleItemRequest(
  method: string,
  id: string,
  resource: ResourceRoute,
  store: ResourceStore,
  body: Record<string, unknown> | undefined,
  res: ServerResponse,
): void {
  if (method === 'get') {
    const record = store.get(resource.collectionPath, id);
    if (!record) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    sendJson(res, 200, record);
    return;
  }

  if (method === 'put' || method === 'patch') {
    const existing = store.get(resource.collectionPath, id);
    if (!existing && method === 'patch') {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    const updated: Record<string, unknown> =
      method === 'patch' ? { ...existing, ...body, id } : { ...body, id };
    store.put(resource.collectionPath, id, updated);
    sendJson(res, 200, updated);
    return;
  }

  if (method === 'delete') {
    const deleted = store.delete(resource.collectionPath, id);
    if (!deleted) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
}

function handleCollectionRequest(
  method: string,
  resource: ResourceRoute,
  operation: OperationObject,
  store: ResourceStore,
  body: Record<string, unknown> | undefined,
  res: ServerResponse,
): void {
  if (method === 'get') {
    seedIfEmpty(resource, operation, store);
    sendJson(res, 200, store.list(resource.collectionPath));
    return;
  }

  if (method === 'post') {
    const itemSchema = itemSchemaFor(operation, [201, 200]);
    const generated = generateFromSchema(itemSchema);
    const record: Record<string, unknown> = {
      ...(generated && typeof generated === 'object' ? generated : {}),
      ...body,
      id: randomUUID(),
    };
    store.put(resource.collectionPath, record['id'] as string, record);
    sendJson(res, 201, record);
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
}

function seedIfEmpty(
  resource: ResourceRoute,
  operation: OperationObject,
  store: ResourceStore,
): void {
  if (store.has(resource.collectionPath)) {
    return;
  }
  const itemSchema = itemSchemaFor(operation, [200]);
  for (let i = 0; i < SEED_COUNT; i += 1) {
    const generated = generateFromSchema(itemSchema);
    const record: Record<string, unknown> = {
      ...(generated && typeof generated === 'object' ? generated : {}),
      id: randomUUID(),
    };
    store.put(resource.collectionPath, record['id'] as string, record);
  }
}

function itemSchemaFor(
  operation: OperationObject,
  codes: number[],
): SchemaObject | undefined {
  const schema = responseSchemaFor(operation, codes);
  return schema?.type === 'array' ? schema.items : schema;
}

function responseSchemaFor(
  operation: OperationObject,
  codes: number[],
): SchemaObject | undefined {
  for (const code of codes) {
    const schema =
      operation.responses[String(code)]?.content?.['application/json']?.schema;
    if (schema) {
      return schema;
    }
  }
  return undefined;
}

function respondWithExample(
  operation: OperationObject,
  res: ServerResponse,
): void {
  const codes = Object.keys(operation.responses);
  const successCode = codes.find((code) => code.startsWith('2')) ?? codes[0];
  if (!successCode) {
    res.writeHead(204);
    res.end();
    return;
  }

  const content =
    operation.responses[successCode]?.content?.['application/json'];
  if (!content) {
    res.writeHead(Number.parseInt(successCode, 10) || 200);
    res.end();
    return;
  }

  const body = content.example ?? generateFromSchema(content.schema);
  sendJson(res, Number.parseInt(successCode, 10) || 200, body);
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
