export interface SchemaObject {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: unknown[];
  example?: unknown;
  minimum?: number;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  [key: string]: unknown;
}

export interface MediaTypeObject {
  schema?: SchemaObject;
  example?: unknown;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
}

export interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, MediaTypeObject>;
}

export interface OperationObject {
  operationId?: string;
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
  [key: string]: unknown;
}

export interface PathItem {
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  [key: string]: unknown;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
  };
  [key: string]: unknown;
}
