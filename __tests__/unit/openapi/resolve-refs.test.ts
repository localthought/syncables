import { describe, expect, it } from 'vitest';
import { resolveRefs } from '../../../src/openapi/resolve-refs.js';

describe('resolveRefs', () => {
  it('inlines a referenced schema', () => {
    const document = {
      components: {
        schemas: {
          Name: { type: 'string' },
        },
      },
      target: { $ref: '#/components/schemas/Name' },
    };

    const resolved = resolveRefs(document);

    expect(resolved.target).toEqual({ type: 'string' });
  });

  it('resolves the same ref reused in multiple places', () => {
    const document = {
      components: {
        schemas: {
          Name: { type: 'string' },
        },
      },
      a: { $ref: '#/components/schemas/Name' },
      b: { $ref: '#/components/schemas/Name' },
    };

    const resolved = resolveRefs(document);

    expect(resolved.a).toEqual({ type: 'string' });
    expect(resolved.b).toEqual({ type: 'string' });
  });

  it('does not loop forever on a self-referencing schema', () => {
    const document = {
      components: {
        schemas: {
          Category: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              parent: { $ref: '#/components/schemas/Category' },
            },
          },
        },
      },
    };

    const resolved = resolveRefs(document);
    const category = resolved.components.schemas.Category as Record<string, unknown>;
    const properties = category['properties'] as Record<string, unknown>;

    expect(properties['name']).toEqual({ type: 'string' });

    // The cycle is cut off at a finite depth rather than resolved forever,
    // so the whole structure stays plain-object-shaped and serializable.
    expect(() => JSON.stringify(resolved)).not.toThrow();
  });
});
