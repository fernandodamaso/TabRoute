import { createDefaultConfiguration } from "../../src/domain/defaults";
import type { Configuration } from "../../src/domain/types";
import type { LiveChromePort } from "../../src/chrome/types";
import { createTabRouteController } from "../../src/controller/controller";
import { createPreMutationCheckpointService } from "../../src/snapshots/checkpointService";
import {
  createMemoryLocalRepository,
  type LocalRepository
} from "../../src/state/localRepository";
import {
  createMemorySessionRepository,
  type SessionRepository
} from "../../src/state/sessionRepository";

export function createControllerPersistence(input?: {
  configuration?: Configuration;
  session?: SessionRepository;
  local?: LocalRepository;
}) {
  const configuration =
    input?.configuration ?? createDefaultConfiguration(() => crypto.randomUUID());
  const local = input?.local ?? createMemoryLocalRepository();
  const session = input?.session ?? createMemorySessionRepository();
  const checkpoints = createPreMutationCheckpointService({
    local,
    captureContext: async () => ({
      configuration,
      ownership: await local.loadWindowOwnership(),
      associations: []
    })
  });
  return { configuration, local, session, checkpoints };
}

export function createTestController(input: {
  configuration: Configuration;
  chrome: LiveChromePort;
  session?: SessionRepository;
  local?: LocalRepository;
  now?: () => number;
}) {
  const persistence = createControllerPersistence({
    configuration: input.configuration,
    session: input.session,
    local: input.local
  });
  return createTabRouteController({
    configuration: input.configuration,
    chrome: input.chrome,
    session: persistence.session,
    local: persistence.local,
    checkpoints: persistence.checkpoints,
    now: input.now
  });
}
