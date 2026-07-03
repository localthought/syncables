import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { applyOverlay, loadOverlay } from '../../../src/openapi/overlay.js';
import { validatePaginationScheme } from '../../../src/pagination/validate.js';
import { createMockServer, type MockServer } from '../../../src/mock-server/server.js';
import { createApiClient, type ApiClient } from '../../../src/client/client.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';

/**
 * These test the OpenAPI Pagination Schemes Extension support
 * (https://github.com/pondersource/openapi-pagination-schemes-extension)
 * against the real, unmodified overlays published for Giphy and Spotify at
 * https://github.com/localthought/overlays, applied on top of the same
 * vendored real-world documents used in real-world.test.ts.
 *
 * Both overlays target genuine LIST endpoints (/gifs/trending,
 * /artists/{id}/albums) rather than the collection/item "resources"
 * discovered elsewhere in this test suite — in both real APIs, the
 * batch-get-by-IDs endpoints that happen to pair into a resource
 * (/gifs, /albums, ...) aren't the paginated ones; pagination is a
 * property of list/search operations, which is orthogonal to this
 * library's collection+item resource model.
 */

function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../../fixtures/real-world/${name}`, import.meta.url),
  );
}

async function loadWithOverlay(
  documentFile: string,
  overlayFile: string,
): Promise<OpenApiDocument> {
  const document = await loadOpenApiDocument(fixturePath(documentFile));
  const overlay = await loadOverlay(fixturePath(overlayFile));
  return applyOverlay(document, overlay);
}

describe('acceptance: pagination extension on giphy.com', () => {
  let document: OpenApiDocument;
  let server: MockServer;
  let client: ApiClient;

  beforeAll(async () => {
    document = await loadWithOverlay('giphy.yaml', 'giphy-pagination-overlay.yaml');
    server = createMockServer(document);
    const info = await server.listen();
    client = createApiClient(document, { baseUrl: info.url });
  });

  afterAll(() => server.close());

  it('applies the overlay, adding a paginationSchemes entry', () => {
    expect(document.components?.paginationSchemes).toHaveProperty('offset');
  });

  it("rejects Giphy's own scheme as spec-invalid", () => {
    const scheme = document.components?.paginationSchemes?.['offset'];
    expect(scheme).toBeDefined();
    const errors = validatePaginationScheme('offset', scheme!);

    // The vendored overlay declares `type: offset`, but the spec only
    // allows pageNumber | pageToken | nextLink (offset is a *role*, not a
    // scheme type) — and reuses that same invalid value as a *response*
    // role, which isn't valid there either (offset is request-only).
    expect(errors).toEqual([
      expect.stringContaining('type must be one of pageNumber, pageToken, or nextLink'),
      expect.stringContaining('response.bodyFields.pagination.offset.role is not a valid response role'),
    ]);
  });

  it('falls back to single-page behavior since no valid scheme applies', async () => {
    // /gifs/trending is a genuinely paginated real endpoint (has limit and
    // offset query parameters, a clean response schema), but because the
    // only declared scheme is invalid, pagination doesn't engage here:
    // the mock server serves it as a plain documented-example response
    // (one generated Gif), and the client's best-effort item extraction
    // still unwraps the `data` envelope, returning that single item.
    const items = await client.paginate('/gifs/trending');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveProperty('id');
  });
});

describe('acceptance: pagination extension on spotify.com', () => {
  let document: OpenApiDocument;
  let server: MockServer;
  let client: ApiClient;
  let baseUrl: string;

  beforeAll(async () => {
    document = await loadWithOverlay('spotify.yaml', 'spotify-pagination-overlay.yaml');
    server = createMockServer(document);
    const info = await server.listen();
    baseUrl = info.url;
    client = createApiClient(document, { baseUrl });
  });

  afterAll(() => server.close());

  it('applies the overlay, adding valid paginationSchemes entries', () => {
    const schemes = document.components?.paginationSchemes ?? {};
    expect(Object.keys(schemes).sort()).toEqual(['cursor', 'offset']);
    for (const [name, scheme] of Object.entries(schemes)) {
      expect(validatePaginationScheme(name, scheme)).toEqual([]);
    }
  });

  it('traverses every page of a real paginated list endpoint', async () => {
    // /artists/{id}/albums is not one of the collection/item "resources"
    // discovered elsewhere (it has no sibling item route) — it's a plain
    // list operation matched purely by its pagination scheme. With
    // pageSize 3 and the mock server's fixed 7-item dataset, this
    // requires three requests (3 + 3 + 1) to fully traverse.
    const items = await client.paginate('/artists/4Z8W4fKeB5YxbusRsdQVPb/albums', {
      pageSize: 3,
    });

    expect(items).toHaveLength(7);
    const ids = items.map((item) => item['id']);
    expect(new Set(ids).size).toBe(7);
  });

  it('reports accurate pagination metadata across pages', async () => {
    const path = '/artists/4Z8W4fKeB5YxbusRsdQVPb/albums';

    const firstResponse = await fetch(`${baseUrl}${path}?limit=3&offset=0`);
    const firstPage = (await firstResponse.json()) as Record<string, unknown>;
    expect(firstPage['total']).toBe(7);
    expect(typeof firstPage['next']).toBe('string');
    expect(firstPage['next']).toContain('offset=3');

    const lastResponse = await fetch(`${baseUrl}${path}?limit=3&offset=6`);
    const lastPage = (await lastResponse.json()) as Record<string, unknown>;
    expect(lastPage['total']).toBe(7);
    expect(Array.isArray(lastPage['items'])).toBe(true);
    expect((lastPage['items'] as unknown[]).length).toBe(1);
    // No more pages after this one.
    expect(lastPage['next']).toBeNull();
  });
});
