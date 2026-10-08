// A stored record looked up by an id that comes from a caller. On a plain object, "constructor" or "__proto__"
// name something that is not a record at all (they are inherited), so a lookup must only see own keys.
export function ownRecord<T>(map: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(map, id) ? map[id] : undefined;
}
