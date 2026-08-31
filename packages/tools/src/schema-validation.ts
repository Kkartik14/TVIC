export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function deepEqual(
  a: unknown,
  b: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (typeof a === "object") {
    const ao = a as object;
    const bo = b as object;
    const seenForA = seen.get(ao);
    if (seenForA?.has(bo)) return true;
    if (seenForA) seenForA.add(bo);
    else {
      const pairs = new WeakSet<object>();
      pairs.add(bo);
      seen.set(ao, pairs);
    }
    try {
      if (Array.isArray(a) || Array.isArray(b)) {
        return (
          Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          a.every((item, index) => deepEqual(item, b[index], seen))
        );
      }
      const objectA = a as Record<string, unknown>;
      const objectB = b as Record<string, unknown>;
      const keys = new Set([...Object.keys(objectA), ...Object.keys(objectB)]);
      return [...keys].every((key) => deepEqual(objectA[key], objectB[key], seen));
    } catch {
      return false;
    }
  }
  return false;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  return expected === typeOf(value);
}

/**
 * Validates a value against a deliberately small, well-defined subset of JSON Schema
 * (Draft-07 keywords): `type` (incl. "integer"), `enum`, `const`, object
 * `properties` / `required` / `additionalProperties: false`, array `items` /
 * `minItems` / `maxItems`, string `minLength` / `maxLength`, and numeric `minimum` /
 * `maximum`. It is intentionally NOT a full validator: unsupported keywords are
 * ignored. Swap in Ajv at the call site if full JSON Schema compliance is required.
 */
export function validateJsonSchemaSubset(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path = "$",
): SchemaValidationResult {
  const errors: string[] = [];
  validateNode(value, schema, path, errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  errors: string[],
): void {
  if ("const" in schema && !deepEqual(value, schema.const)) {
    errors.push(`${path} must equal ${safeJsonForMessage(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path} must be one of ${safeJsonForMessage(schema.enum)}`);
  }

  const expectedType = schema.type;
  if (typeof expectedType === "string" && !matchesType(value, expectedType)) {
    errors.push(`${path} expected ${expectedType}, received ${typeOf(value)}`);
    return; // a type mismatch makes deeper checks meaningless
  }

  if (expectedType === "object") {
    validateObjectNode(value, schema, path, errors);
  } else if (expectedType === "array") {
    validateArrayNode(value, schema, path, errors);
  } else if (expectedType === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} must have length >= ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} must have length <= ${schema.maxLength}`);
    }
  } else if (
    (expectedType === "number" || expectedType === "integer") &&
    typeof value === "number"
  ) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }
}

function validateObjectNode(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  errors: string[],
): void {
  const objectValue = asObject(value);
  if (!objectValue) {
    errors.push(`${path} expected object`);
    return;
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!(key in objectValue)) {
      errors.push(`${path}.${key} is required`);
    }
  }

  const properties = asObject(schema.properties);
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in objectValue) || !asObject(propertySchema)) {
        continue;
      }
      validateNode(
        objectValue[key],
        propertySchema as Readonly<Record<string, unknown>>,
        `${path}.${key}`,
        errors,
      );
    }
  }

  if (schema.additionalProperties === false && properties) {
    for (const key of Object.keys(objectValue)) {
      if (!(key in properties)) {
        errors.push(`${path}.${key} is not an allowed property`);
      }
    }
  }
}

function validateArrayNode(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} expected array`);
    return;
  }
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push(`${path} must have >= ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push(`${path} must have <= ${schema.maxItems} items`);
  }
  const itemSchema = asObject(schema.items);
  if (itemSchema) {
    value.forEach((item, index) => {
      validateNode(item, itemSchema, `${path}[${index}]`, errors);
    });
  }
}

function safeJsonForMessage(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable value]";
  }
}
