/** RFC 6901 JSON pointer helpers and dotted key-path access used by schema descriptors. */

/** Escapes one reference token (`~` → `~0`, `/` → `~1`). */
export function escapeToken(token: string | number): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Appends one token to a pointer: `childPointer("/a", 0)` → `"/a/0"`. The root pointer is `""`. */
export function childPointer(parent: string, token: string | number): string {
  return `${parent}/${escapeToken(token)}`;
}

/** The pointer one level up; the parent of the root is the root. */
export function parentPointer(pointer: string): string {
  const cut = pointer.lastIndexOf("/");
  return cut <= 0 ? "" : pointer.slice(0, cut);
}

/** Converts a dotted key path (`"meta.name"`) to a relative pointer suffix (`"/meta/name"`). */
export function keyPathToPointer(keyPath: string): string {
  return keyPath
    .split(".")
    .map((part) => `/${escapeToken(part)}`)
    .join("");
}

/** Reads a dotted key path from a value; `undefined` when any step is missing or not an object. */
export function getKeyPath(value: unknown, keyPath: string): unknown {
  let current: unknown = value;
  for (const part of keyPath.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Defines an own enumerable property without ever invoking the `__proto__` setter. */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
