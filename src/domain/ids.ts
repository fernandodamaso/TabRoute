import type { UUID } from "./types";

export function createUuid(randomUuid: () => string = () => crypto.randomUUID()): UUID {
  return randomUuid() as UUID;
}
