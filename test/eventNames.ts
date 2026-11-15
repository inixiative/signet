import type { AccessEventsAppend } from '../src';

const ids = new Map<string, string>();

/** A test event's `id` (Kingdom's UUID), the same for the same name. */
export const eventIdOf = (name: string) => {
  const id = ids.get(name) ?? Bun.randomUUIDv7();
  ids.set(name, id);
  return id;
};

/** The name a test gave the event an append carries. */
export const eventNameOf = (append: AccessEventsAppend) =>
  [...ids].find(([, id]) => id === append.event.id)?.[0] ?? append.event.id;
