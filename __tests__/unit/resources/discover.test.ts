import { describe, expect, it } from 'vitest';
import { discoverResources } from '../../../src/resources/discover.js';

describe('discoverResources', () => {
  it('pairs a collection path with its item path', () => {
    const resources = discoverResources({
      '/pets': {},
      '/pets/{petId}': {},
    });

    expect(resources).toEqual([
      { collectionPath: '/pets', itemPath: '/pets/{petId}', itemParam: 'petId' },
    ]);
  });

  it('omits paths that have no matching item path', () => {
    const resources = discoverResources({
      '/health': {},
      '/pets': {},
      '/pets/{petId}': {},
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]?.collectionPath).toBe('/pets');
  });

  it('does not pair paths from unrelated collections', () => {
    const resources = discoverResources({
      '/pets': {},
      '/owners/{ownerId}': {},
    });

    expect(resources).toEqual([]);
  });
});
