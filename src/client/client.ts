import {
  discoverResources,
  type ResourceRoute,
} from '../resources/discover.js';
import type { OpenApiDocument } from '../openapi/types.js';
import { InMemoryStorageAdapter, type StorageAdapter } from './storage.js';

export interface ApiClientOptions {
  baseUrl: string;
  storage?: StorageAdapter;
  fetch?: typeof fetch;
}

export interface ApiClient {
  resources: string[];
  sync(): Promise<void>;
  list(resource: string): Promise<Record<string, unknown>[]>;
  get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined>;
  create(
    resource: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  update(
    resource: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  remove(resource: string, id: string): Promise<void>;
}

/**
 * Builds a client that talks to an API described by `document` and keeps
 * a local copy of each resource collection in `storage` (in-memory by
 * default). Reads serve from the local copy; writes go to the API first
 * and then update the local copy on success.
 */
export function createApiClient(
  document: OpenApiDocument,
  options: ApiClientOptions,
): ApiClient {
  const storage = options.storage ?? new InMemoryStorageAdapter();
  const fetchImpl = options.fetch ?? fetch;
  const routes = discoverResources(document.paths);
  const byResource = new Map(
    routes.map((route) => [route.collectionPath, route]),
  );

  function resolveRoute(resource: string): ResourceRoute {
    const route = byResource.get(resource);
    if (!route) {
      throw new Error(
        `Unknown resource "${resource}". Known resources: ${[...byResource.keys()].join(', ')}`,
      );
    }
    return route;
  }

  function collectionUrl(route: ResourceRoute): string {
    return new URL(route.collectionPath, options.baseUrl).toString();
  }

  function itemUrl(route: ResourceRoute, id: string): string {
    const path = route.itemPath.replace(
      `{${route.itemParam}}`,
      encodeURIComponent(id),
    );
    return new URL(path, options.baseUrl).toString();
  }

  async function requestJson(
    url: string,
    init?: RequestInit,
  ): Promise<unknown> {
    const response = await fetchImpl(url, init);
    if (response.status === 204) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(
        `Request to ${url} failed with status ${response.status}`,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  return {
    resources: [...byResource.keys()],

    async sync(): Promise<void> {
      for (const route of byResource.values()) {
        const items = (await requestJson(collectionUrl(route))) as
          | Record<string, unknown>[]
          | undefined;
        for (const item of items ?? []) {
          await storage.put(route.collectionPath, String(item['id']), item);
        }
      }
    },

    async list(resource): Promise<Record<string, unknown>[]> {
      return storage.list(resolveRoute(resource).collectionPath);
    },

    async get(resource, id): Promise<Record<string, unknown> | undefined> {
      return storage.get(resolveRoute(resource).collectionPath, id);
    },

    async create(resource, data): Promise<Record<string, unknown>> {
      const route = resolveRoute(resource);
      const created = (await requestJson(collectionUrl(route), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })) as Record<string, unknown>;
      await storage.put(route.collectionPath, String(created['id']), created);
      return created;
    },

    async update(resource, id, data): Promise<Record<string, unknown>> {
      const route = resolveRoute(resource);
      const updated = (await requestJson(itemUrl(route, id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })) as Record<string, unknown>;
      await storage.put(route.collectionPath, id, updated);
      return updated;
    },

    async remove(resource, id): Promise<void> {
      const route = resolveRoute(resource);
      await requestJson(itemUrl(route, id), { method: 'DELETE' });
      await storage.delete(route.collectionPath, id);
    },
  };
}
