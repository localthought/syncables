import {
  discoverResources,
  type ResourceRoute,
} from '../resources/discover.js';
import type {
  OpenApiDocument,
  OperationObject,
  SchemaObject,
} from '../openapi/types.js';
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

export interface SyncResult {
  /** Collection paths whose local copy was actually added to, updated, or pruned by this sync. */
  changed: string[];
}

export interface PollOptions {
  /** How often to call `sync()`, in milliseconds. An initial sync runs immediately. */
  intervalMs: number;
  /** Called after every sync while polling, including ones where nothing changed. */
  onSync?: (result: SyncResult) => void;
  /** Called when a sync throws while polling; polling continues on the next interval. */
  onError?: (error: unknown) => void;
}

export interface PollingHandle {
  /** Stops future polling. Does not cancel a sync already in flight. */
  stop(): void;
}

export interface ApiClient {
  resources: string[];
  sync(): Promise<SyncResult>;
  /**
   * Calls `sync()` on `options.intervalMs`, skipping a tick if the previous
   * sync is still running. Returns a handle whose `stop()` cancels it.
   */
  startPolling(options: PollOptions): PollingHandle;
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
 * Fields commonly used by real APIs to signal that a record changed,
 * checked in this order. When an item has none of these, its fingerprint
 * falls back to a full serialization, which still lets `hasChanges` detect
 * per-item edits without any server cooperation.
 */
const CHANGE_INDICATOR_FIELDS = [
  'updatedAt',
  'updated_at',
  'modifiedAt',
  'modified_at',
  'version',
  'revision',
  '_rev',
  'etag',
];

function itemFingerprint(item: Record<string, unknown>): string {
  for (const field of CHANGE_INDICATOR_FIELDS) {
    if (field in item) {
      return `${field}:${String(item[field])}`;
    }
  }
  return JSON.stringify(item);
}

/**
 * Compares a previously synced item list against a freshly fetched one to
 * decide whether local storage actually needs updating — the fallback used
 * when the server gave no (or an untrusted) conditional-request signal.
 */
function hasChanges(
  previous: Record<string, unknown>[] | undefined,
  next: Record<string, unknown>[],
): boolean {
  if (!previous || previous.length !== next.length) {
    return true;
  }
  const previousById = new Map(
    previous.map((item) => [String(item['id']), item]),
  );
  return next.some((item) => {
    const match = previousById.get(String(item['id']));
    return !match || itemFingerprint(match) !== itemFingerprint(item);
  });
}

function extractItemsFromEnvelope(
  body: Record<string, unknown>,
  responseSchema: SchemaObject | undefined,
): Record<string, unknown>[] {
  const field = locateItemsField(responseSchema, undefined);
  const items = field ? body[field] : undefined;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
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
  // Keyed by exact request URL: the ETag/Last-Modified last seen for it, so
  // the next sync can ask the server "has this changed?" via If-None-Match /
  // If-Modified-Since instead of re-fetching the full body.
  const conditionalCache = new Map<
    string,
    { etag?: string; lastModified?: string }
  >();
  // Keyed by collection path: the item list stored there as of the last
  // sync, used both to fall back on for a 304 response and to diff against
  // a fresh 200 response (see `hasChanges`).
  const lastSyncedItems = new Map<string, Record<string, unknown>[]>();

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

  /**
   * Fetches a resource's collection, conditionally: sends If-None-Match /
   * If-Modified-Since from a prior response (if any), and on a 304 returns
   * the item list last stored for it instead of re-parsing a body. Only
   * used for the non-paginated case, since it's the one `sync()` can
   * meaningfully short-circuit — pagination has already been walked and
   * assembled by the time a scheme applies.
   */
  async function fetchCollectionSnapshot(
    route: ResourceRoute,
    operation: OperationObject | undefined,
  ): Promise<{ items: Record<string, unknown>[]; notModified: boolean }> {
    const url = collectionUrl(route);
    const responseSchema =
      operation?.responses['200']?.content?.['application/json']?.schema;
    const cached = conditionalCache.get(url);
    const headers: Record<string, string> = {};
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }
    if (cached?.lastModified) {
      headers['If-Modified-Since'] = cached.lastModified;
    }

    const response = await fetchImpl(
      url,
      Object.keys(headers).length > 0 ? { headers } : undefined,
    );

    if (response.status === 304) {
      return {
        items: lastSyncedItems.get(route.collectionPath) ?? [],
        notModified: true,
      };
    }
    if (!response.ok) {
      throw new Error(
        `Request to ${url} failed with status ${response.status}`,
      );
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    if (etag || lastModified) {
      conditionalCache.set(url, {
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      });
    } else {
      conditionalCache.delete(url);
    }

    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : {};
    const items = Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : extractItemsFromEnvelope(
          body as Record<string, unknown>,
          responseSchema,
        );

    return { items, notModified: false };
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

  /**
   * Syncs every discovered resource. For a non-paginated collection, this
   * conditionally re-fetches (see `fetchCollectionSnapshot`) and, even on a
   * fresh 200, only touches storage for items that actually changed
   * (`hasChanges`) — so calling this repeatedly (e.g. from `startPolling`)
   * doesn't rewrite unchanged local state. Paginated collections are always
   * walked in full (pagination state can't be conditionally short-circuited
   * the same way), but still only diff-write into storage.
   */
  async function performSync(): Promise<SyncResult> {
    const changed: string[] = [];
    for (const route of byResource.values()) {
      const operation = document.paths[route.collectionPath]?.get;
      const isPaginated = operation
        ? Boolean(resolveEffectiveScheme(document, operation))
        : false;

      const { items, notModified } = isPaginated
        ? {
            items: await fetchAllItems(
              route.collectionPath,
              operation as OperationObject,
              undefined,
            ),
            notModified: false,
          }
        : await fetchCollectionSnapshot(route, operation);

      if (notModified) {
        continue;
      }

      const previous = lastSyncedItems.get(route.collectionPath);
      if (hasChanges(previous, items)) {
        changed.push(route.collectionPath);
        for (const item of items) {
          await storage.put(route.collectionPath, String(item['id']), item);
        }
        if (previous) {
          const nextIds = new Set(items.map((item) => String(item['id'])));
          for (const staleItem of previous) {
            const staleId = String(staleItem['id']);
            if (!nextIds.has(staleId)) {
              await storage.delete(route.collectionPath, staleId);
            }
          }
        }
      }
      lastSyncedItems.set(route.collectionPath, items);
    }
    return { changed };
  }

  return {
    resources: [...byResource.keys()],

    sync: performSync,

    startPolling(pollOptions): PollingHandle {
      let stopped = false;
      let syncInFlight = false;

      const tick = (): void => {
        if (stopped || syncInFlight) {
          return;
        }
        syncInFlight = true;
        performSync()
          .then((result) => pollOptions.onSync?.(result))
          .catch((error: unknown) => pollOptions.onError?.(error))
          .finally(() => {
            syncInFlight = false;
          });
      };

      tick();
      const timer = setInterval(tick, pollOptions.intervalMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      return {
        stop(): void {
          stopped = true;
          clearInterval(timer);
        },
      };
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
