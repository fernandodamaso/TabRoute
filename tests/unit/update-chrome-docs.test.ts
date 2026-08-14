import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateChromeDocs } from "../../scripts/update-chrome-docs";

const manifest = {
  schemaVersion: 1,
  licenseNotice:
    "Chrome developer documentation is generally CC BY 4.0; code samples are Apache 2.0.",
  sources: [
    {
      id: "tabs",
      file: "vendor/tabs.md",
      url: "https://developer.chrome.com/docs/extensions/reference/api/tabs",
      purpose: "tabs"
    },
    {
      id: "tab-groups",
      file: "vendor/tab-groups.md",
      url: "https://developer.chrome.com/docs/extensions/reference/api/tabGroups",
      purpose: "groups"
    }
  ]
};

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "tabroute-docs-"));
  await mkdir(join(root, "docs/chrome-reference/vendor"), { recursive: true });
  await writeFile(
    join(root, "docs/chrome-reference/sources.json"),
    JSON.stringify(manifest, null, 2)
  );
  await writeFile(
    join(root, "docs/chrome-reference/vendor/tabs.md"),
    "old tabs snapshot\n"
  );
  await writeFile(
    join(root, "docs/chrome-reference/vendor/tab-groups.md"),
    "old groups snapshot\n"
  );
  return root;
}

function response(body: string, _url: string) {
  return new Response(`<article><h1>Chrome API</h1><p>${body}</p></article>`, {
    status: 200,
    headers: { "content-type": "text/html" }
  });
}

it("leaves the previous reference set untouched when one required fetch fails", async () => {
  const root = await fixtureRoot();
  const before = await readFile(
    join(root, "docs/chrome-reference/vendor/tabs.md"),
    "utf8"
  );

  await expect(
    updateChromeDocs({
      rootDir: root,
      fetchImpl: async (input) => {
        if (String(input).endsWith("tabGroups"))
          throw new Error("tab-groups unavailable");
        return response("tabs", String(input));
      },
      now: () => new Date("2026-08-08T20:00:00.000Z")
    })
  ).rejects.toThrow("tab-groups");

  expect(
    await readFile(join(root, "docs/chrome-reference/vendor/tabs.md"), "utf8")
  ).toBe(before);
});

it("writes attribution, retrieval time, and sha256 for every successful source", async () => {
  const root = await fixtureRoot();
  const result = await updateChromeDocs({
    rootDir: root,
    fetchImpl: async (input) => response(String(input), String(input)),
    now: () => new Date("2026-08-08T20:00:00.000Z")
  });

  expect(result.updatedIds).toEqual(["tabs", "tab-groups"]);
  expect(result.sources).toHaveLength(2);
  expect(
    result.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256))
  ).toBe(true);
  expect(
    await readFile(join(root, "docs/chrome-reference/vendor/tabs.md"), "utf8")
  ).toContain("Retrieved at (UTC): 2026-08-08T20:00:00.000Z");
});
