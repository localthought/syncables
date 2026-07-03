import {
  discoverResources,
  type ResourceRoute,
} from '../resources/discover.js';
import type { OpenApiDocument, OperationObject } from '../openapi/types.js';
import { findRoute } from '../routing/router.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import {
  buildQuery,
  nextCursor,
  type PageCursor,
} from '../pagination/request-builder.js';
import { parsePaginationState } from '../pagination/response-parser.js';
import { locateItemsField } from '../pagination/items.js';
import { InMemoryStorageAdapter, type StorageAdapter } from './storage.js';

export interface ApiClientOptions {
  baseUrl: string;
  storage?: StorageAdapter;
  fetch?: typeof fetch;
}

export interface PaginateOptions {
  /** Page size to request. Falls back to the server's own default when omitted. */
  pageSize?: number;
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
  /**
   * Fetches every item from a GET list operation at `path`, walking every
   * page per its resolved pagination scheme (explicit `x-pagination` or
   * auto-detected from `components.paginationSchemes`). `path` need not be
   * a discovered resource — any GET operation in the document works, e.g.
   * a search/listing endpoint with no paired item route.
   */
  paginate(
    path: string,
    options?: PaginateOptions,
  ): Promise<Record<string, unknown>[]>;
}

const MAX_PAGES = 50;

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

  async function requestJsonWithHeaders(url: string): Promise<{
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(
        `Request to ${url} failed with status ${response.status}`,
      );
    }
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      body: parsed && typeof parsed === 'object' ? parsed : {},
      headers,
    };
  }

  function findGetOperation(
    path: string,
  ): { operation: OperationObject; template: string } | undefined {
    const match = findRoute(Object.keys(document.paths), path);
    if (!match) {
      return undefined;
    }
    const operation = document.paths[match.template]?.get;
    return operation ? { operation, template: match.template } : undefined;
  }

  /**
   * Fetches every item from a GET operation, following its resolved
   * pagination scheme across pages. When no scheme applies, falls back to
   * a single request, still attempting to locate the items in an
   * enveloped (non-array) response body.
   */
  async function fetchAllItems(
    path: string,
    operation: OperationObject,
    pageSize: number | undefined,
  ): Promise<Record<string, unknown>[]> {
    const responseSchema =
      operation.responses['200']?.content?.['application/json']?.schema;
    const effective = resolveEffectiveScheme(document, operation);

    if (!effective) {
      const { body } = await requestJsonWithHeaders(
        new URL(path, options.baseUrl).toString(),
      );
      if (Array.isArray(body)) {
        return body as Record<string, unknown>[];
      }
      const field = locateItemsField(responseSchema, undefined);
      const items = field ? body[field] : undefined;
      return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
    }

    const { scheme } = effective;
    const itemsField = locateItemsField(responseSchema, scheme);
    const items: Record<string, unknown>[] = [];
    let cursor: PageCursor = {};
    let nextUrl: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      let url = nextUrl;
      if (!url) {
        const target = new URL(path, options.baseUrl);
        const query = buildQuery(scheme, cursor, pageSize);
        for (const [key, value] of Object.entries(query)) {
          target.searchParams.set(key, value);
        }
        url = target.toString();
      }

      const { body, headers } = await requestJsonWithHeaders(url);
      const pageItems = itemsField ? body[itemsField] : undefined;
      if (Array.isArray(pageItems)) {
        items.push(...(pageItems as Record<string, unknown>[]));
      }

      const state = parsePaginationState(scheme, body, headers, items.length);
      if (!state.hasNextPage) {
        break;
      }

      if (scheme.type === 'nextLink') {
        if (!state.nextLink) {
          break;
        }
        nextUrl = state.nextLink;
      } else {
        const next = nextCursor(
          scheme,
          cursor,
          state,
          Array.isArray(pageItems) ? pageItems.length : 0,
        );
        if (!next) {
          break;
        }
        cursor = next;
        nextUrl = undefined;
      }
    }

    return items;
  }

  return {
    resources: [...byResource.keys()],

    async sync(): Promise<void> {
      for (const route of byResource.values()) {
        const operation = document.paths[route.collectionPath]?.get;
        const items = operation
          ? await fetchAllItems(route.collectionPath, operation, undefined)
          : (((await requestJson(collectionUrl(route))) as
              | Record<string, unknown>[]
              | undefined) ?? []);
        for (const item of items) {
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

    async paginate(
      path,
      paginateOptions = {},
    ): Promise<Record<string, unknown>[]> {
      const found = findGetOperation(path);
      if (!found) {
        throw new Error(`No GET operation found for path "${path}"`);
      }
      return fetchAllItems(path, found.operation, paginateOptions.pageSize);
    },
  };
}
