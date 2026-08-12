// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration, createManagedGroup } from "../../src/domain/defaults";
import type { Configuration, UUID } from "../../src/domain/types";
import { ManagerApp } from "../../src/ui/manager/ManagerApp";
import { createChromeManagerTransport } from "../../src/ui/manager/chromeManagerTransport";
import type {
  ManagerMessage,
  ManagerResponse,
  ManagerViewMetadata
} from "../../src/ui/manager/types";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
} satisfies ManagerViewMetadata;

function configurationWithRule(): { configuration: Configuration; ruleId: UUID } {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const ruleId = "00000000-0000-4000-8000-000000000004" as UUID;
  return {
    ruleId,
    configuration: {
      ...configuration,
      rules: [
        {
          schemaVersion: 1,
          id: ruleId,
          targetGroupId: configuration.groups[0]!.id,
          priority: 10,
          positive: { kind: "title", operator: "contains", value: "Docs" },
          negative: [],
          actions: [{ kind: "group" }],
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

it("uses the same manager implementation for the options surface", () => {
  render(<ManagerApp surface="options" />);
  expect(screen.getByRole("heading", { name: "Groups" })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
});

it("keeps keyboard order in the shell before page content", async () => {
  const user = userEvent.setup();
  render(<ManagerApp surface="popup" />);
  await user.tab();
  expect(document.activeElement?.getAttribute("data-route-focus")).toBe("groups");
  await user.tab();
  expect(document.activeElement?.getAttribute("data-route-focus")).toBe("rules");
});

it("renders accepted state through an object-shaped manager transport", async () => {
  const fallbackId = "00000000-0000-4000-8000-000000000001";
  const workId = "00000000-0000-4000-8000-000000000002";
  const configuration = createManagedGroup(
    createDefaultConfiguration(() => fallbackId),
    { name: "Work", color: "blue" },
    () => workId,
    () => 2
  );
  const request = vi.fn(async (): Promise<ManagerResponse> => ({
    ok: true,
    configuration,
    view
  }));

  render(<ManagerApp transport={{ request }} />);

  expect(await screen.findByText("Work")).toBeTruthy();
  expect(request).toHaveBeenCalledWith({ kind: "manager-query" });
});

it("honors the initial rules route and new-rule deep link", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const request = vi.fn(async (): Promise<ManagerResponse> => ({
    ok: true,
    configuration,
    view
  }));

  render(<ManagerApp
    transport={{ request }}
    initialRoute="rules"
    initialDeepLink="new-rule"
  />);

  expect(await screen.findByRole("heading", { name: "New rule" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Rules" }).getAttribute("aria-current")).toBe("page");
  expect(request).toHaveBeenCalledWith({ kind: "manager-query" });
});

it("does not reapply the initial route after manager-owned navigation", async () => {
  render(<ManagerApp surface="options" initialRoute="groups" />);
  await screen.findByRole("heading", { name: "Groups" });
  await userEvent.setup().click(screen.getByRole("button", { name: "Open Rules" }));
  expect(await screen.findByRole("heading", { name: "Rules" })).toBeTruthy();
});

it("waits for loaded configuration before mounting a new-rule deep link", async () => {
  const pending = deferred<ManagerResponse>();
  const request = vi.fn(() => pending.promise);
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000002"
  );

  render(<ManagerApp
    transport={{ request }}
    initialRoute="rules"
    initialDeepLink="new-rule"
  />);

  expect(screen.getByRole("status").textContent).toBe("Loading");
  expect(screen.queryByRole("heading", { name: "New rule" })).toBeNull();

  pending.resolve({ ok: true, configuration, view });

  expect(await screen.findByRole("heading", { name: "New rule" })).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Target group" }) as HTMLSelectElement).value)
    .toBe(configuration.groups[0]!.id);
});

it("opens an existing rule from the typed edit deep link after configuration loads", async () => {
  const pending = deferred<ManagerResponse>();
  const request = vi.fn(() => pending.promise);
  const { configuration, ruleId } = configurationWithRule();

  render(<ManagerApp
    transport={{ request }}
    initialRoute="rules"
    initialDeepLink={{ kind: "edit-rule", ruleId }}
  />);

  expect(screen.queryByRole("heading", { name: "Edit rule" })).toBeNull();
  pending.resolve({ ok: true, configuration, view });

  expect(await screen.findByRole("heading", { name: "Edit rule" })).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Condition value 1" }) as HTMLInputElement).value)
    .toBe("Docs");
});

it("opens the existing confirmation overlay from the typed delete deep link", async () => {
  const { configuration, ruleId } = configurationWithRule();
  const request = vi.fn(async (): Promise<ManagerResponse> => ({
    ok: true,
    configuration,
    view
  }));

  render(<ManagerApp
    transport={{ request }}
    initialRoute="rules"
    initialDeepLink={{ kind: "confirm-delete", ruleId }}
  />);

  expect(await screen.findByRole("dialog", { name: "Delete rule?" })).toBeTruthy();
});

it("consumes a delete deep link so later rule updates do not reopen a canceled dialog", async () => {
  const user = userEvent.setup();
  const seeded = configurationWithRule();
  let configuration = seeded.configuration;
  const request = vi.fn(async (message: ManagerMessage): Promise<ManagerResponse> => {
    if (message.kind === "manager-command") {
      const command = message.command;
      if (command.kind === "setRuleEnabled") {
        configuration = {
          ...configuration,
          rules: configuration.rules.map((rule) => rule.id === command.ruleId
            ? { ...rule, enabled: command.enabled }
            : rule)
        };
      }
    }
    return { ok: true, configuration, view };
  });

  render(<ManagerApp
    transport={{ request }}
    initialRoute="rules"
    initialDeepLink={{ kind: "confirm-delete", ruleId: seeded.ruleId }}
  />);

  expect(await screen.findByRole("dialog", { name: "Delete rule?" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Delete rule?" })).toBeNull();

  const enabled = screen.getByRole("checkbox", { name: `Enabled ${seeded.ruleId.slice(0, 8)}` });
  await user.click(enabled);
  await waitFor(() => expect((enabled as HTMLInputElement).checked).toBe(false));

  expect(screen.queryByRole("dialog", { name: "Delete rule?" })).toBeNull();
});

it("surfaces a typed offline transport result without bypassing the transport", async () => {
  const request = vi.fn(async (): Promise<ManagerResponse> => ({
    ok: false,
    error: { kind: "offline", code: "OFFLINE", message: "Chrome runtime is offline" }
  }));

  render(<ManagerApp transport={{ request }} />);

  expect(await screen.findByText("Offline preview")).toBeTruthy();
  expect(request).toHaveBeenCalledWith({ kind: "manager-query" });
});

it("uses typed runtime messaging through the Chrome transport", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const sendMessage = vi.fn(async () => ({ ok: true, configuration, view }));
  const transport = createChromeManagerTransport({ sendMessage });

  const response = await transport.request({ kind: "manager-query" });

  expect(response.ok).toBe(true);
  expect(sendMessage).toHaveBeenCalledWith({ kind: "manager-query" });
});

it("maps a missing runtime response to a typed transport failure", async () => {
  const transport = createChromeManagerTransport({
    sendMessage: vi.fn(async () => undefined)
  });

  const response = await transport.request({ kind: "manager-query" });

  expect(response).toMatchObject({
    ok: false,
    error: { kind: "transport", code: "NO_RESPONSE" }
  });
});

it("records pending and terminal Chrome transport states through the shared record type", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const records: unknown[] = [];
  const transport = createChromeManagerTransport({
    sendMessage: vi.fn(async () => ({ ok: true, configuration, view })),
    onRecord: (record) => records.push(record)
  });

  await transport.request({ kind: "manager-query" });

  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ recordType: "request", state: "pending", mode: "real" });
  expect(records[1]).toMatchObject({ recordType: "request", state: "resolved", mode: "real" });
});
