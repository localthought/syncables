export class ResourceStore {
  private readonly collections = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();

  has(resource: string): boolean {
    return this.collections.has(resource);
  }

  list(resource: string): Record<string, unknown>[] {
    return [...this.collection(resource).values()];
  }

  get(resource: string, id: string): Record<string, unknown> | undefined {
    return this.collection(resource).get(id);
  }

  put(resource: string, id: string, value: Record<string, unknown>): void {
    this.collection(resource).set(id, value);
  }

  delete(resource: string, id: string): boolean {
    return this.collection(resource).delete(id);
  }

  private collection(resource: string): Map<string, Record<string, unknown>> {
    let collection = this.collections.get(resource);
    if (!collection) {
      collection = new Map();
      this.collections.set(resource, collection);
    }
    return collection;
  }
}
