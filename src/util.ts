/**
 * Reads an own property of a lookup table. Keys come from attacker-written
 * markup and CSS, so a plain index would also find `constructor`, `toString`
 * and the rest of `Object.prototype`.
 */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
