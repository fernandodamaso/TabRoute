import { expect, it } from "vitest";
import { fromRule, toRule } from "../../src/ui/manager/rules/flatRuleDraft";
import type { Rule, UUID } from "../../src/domain/types";

const target = "00000000-0000-4000-8000-000000000001" as UUID;
function rule(positive: Rule["positive"], negative: Rule["negative"] = []): Rule {
  return { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000010" as UUID, targetGroupId: target, priority: 7, positive, negative, actions: [{ kind: "group" }], enabled: true, createdAt: 1, updatedAt: 2 };
}

it("maps one required row to a positive leaf and multiple rows to top-level AND", () => {
  const one = fromRule(rule({ kind: "host", operator: "exact", value: "example.com" }));
  expect(one.kind).toBe("representable");
  if (one.kind === "representable") expect(one.draft.required).toHaveLength(1);
  const many = fromRule(rule({ kind: "all", children: [{ kind: "host", operator: "exact", value: "example.com" }, { kind: "path", operator: "prefix", value: "/docs" }] }));
  expect(many.kind).toBe("representable");
  if (many.kind === "representable") expect(toRule(many.draft).positive).toEqual({ kind: "all", children: many.draft.required });
});

it("maps exception rows to negative leaves and round-trips representable rules", () => {
  const source = rule({ kind: "host", operator: "exact", value: "example.com" }, [{ kind: "title", operator: "contains", value: "Blocked" }]);
  source.duplicatePolicy = { kind: "pattern", pattern: "example.com/{path}" };
  source.pausedUntil = "restart";
  const loaded = fromRule(source);
  expect(loaded.kind).toBe("representable");
  if (loaded.kind === "representable") {
    expect(loaded.draft.exceptions).toEqual(source.negative);
    expect(loaded.draft.duplicatePolicy).toEqual(source.duplicatePolicy);
    expect(toRule(loaded.draft)).toEqual(source);
  }
});

it("rejects nested OR or condition groups instead of silently flattening them", () => {
  const result = fromRule(rule({ kind: "any", children: [{ kind: "host", operator: "exact", value: "example.com" }] }));
  expect(result.kind).toBe("unrepresentable");
  if (result.kind === "unrepresentable") expect(result.reason).toMatch(/OR|nested|represent/i);
});
