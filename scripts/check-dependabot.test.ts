import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { checkDependabot, parseDependabotUpdates, runCheck } from "./check-dependabot";

const repoRoot = join(import.meta.dir, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseDependabotUpdates", () => {
  test("reads ecosystem and directory, and ignores nested label lists", () => {
    const updates = parseDependabotUpdates(`
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    labels:
      - dependencies
  - package-ecosystem: github-actions
    directory: /
    labels:
      - dependencies
`);
    expect(updates).toEqual([
      { ecosystem: "npm", directories: ["/"] },
      { ecosystem: "github-actions", directories: ["/"] },
    ]);
  });

  test("reads a directories list", () => {
    const updates = parseDependabotUpdates(`
version: 2
updates:
  - package-ecosystem: npm
    directories:
      - /apps/a
      - "/apps/b"
`);
    expect(updates).toEqual([{ ecosystem: "npm", directories: ["/apps/a", "/apps/b"] }]);
  });
});

describe("checkDependabot", () => {
  test("fails when npm is set and bun.lock is the only lockfile", () => {
    const root = tree({
      "package.json": "{}\n",
      "bun.lock": "{}\n",
      ".github/dependabot.yml": config("npm"),
      ".github/workflows/ci.yml": "name: CI\n",
    });
    expect(checkDependabot(root, read(root))).toEqual([
      {
        directory: "/",
        ecosystem: "npm",
        rule: "lockfile-mismatch",
        detail:
          "bun.lock is present but package-ecosystem is npm, and no package-lock.json, yarn.lock, or pnpm-lock.yaml is present",
      },
    ]);
  });

  test("fails when the directory has no manifest for the ecosystem", () => {
    const root = tree({
      "js/readme.txt": "no package manifest\n",
      "actions/readme.txt": "no workflows\n",
      "rust/readme.txt": "no Cargo.toml\n",
      ".github/dependabot.yml": `
version: 2
updates:
  - package-ecosystem: npm
    directory: /js
  - package-ecosystem: github-actions
    directory: /actions
  - package-ecosystem: cargo
    directory: /rust
`,
    });
    expect(checkDependabot(root, read(root))).toEqual([
      {
        directory: "/js",
        ecosystem: "npm",
        rule: "missing-manifest",
        detail: "no package.json, package-lock.json, npm-shrinkwrap.json, yarn.lock, or pnpm-lock.yaml",
      },
      {
        directory: "/actions",
        ecosystem: "github-actions",
        rule: "missing-manifest",
        detail: "no workflow file under .github/workflows",
      },
      {
        directory: "/rust",
        ecosystem: "cargo",
        rule: "missing-manifest",
        detail: "no manifest for package-ecosystem cargo",
      },
    ]);
  });

  test("passes npm when an npm, yarn, or pnpm lockfile is present", () => {
    for (const lock of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]) {
      const root = tree({
        "package.json": "{}\n",
        [lock]: "{}\n",
        ".github/dependabot.yml": config("npm"),
      });
      expect(checkDependabot(root, read(root))).toEqual([]);
    }
  });

  test("passes npm when package-lock.json is present beside bun.lock", () => {
    const root = tree({
      "package.json": "{}\n",
      "package-lock.json": "{}\n",
      "bun.lock": "{}\n",
      ".github/dependabot.yml": config("npm"),
    });
    expect(checkDependabot(root, read(root))).toEqual([]);
  });

  test("passes bun when bun.lock is present, including a github-actions entry", () => {
    const root = tree({
      "package.json": "{}\n",
      "bun.lock": "{}\n",
      ".github/workflows/ci.yml": "name: CI\n",
      ".github/dependabot.yml": `
version: 2
updates:
  - package-ecosystem: bun
    directory: /
  - package-ecosystem: github-actions
    directory: /
`,
    });
    expect(checkDependabot(root, read(root))).toEqual([]);
  });

  test("passes cargo when Cargo.toml is in the directory", () => {
    const root = tree({
      "rust/Cargo.toml": "[package]\nname = \"demo\"\n",
      ".github/dependabot.yml": `
version: 2
updates:
  - package-ecosystem: cargo
    directory: /rust
`,
    });
    expect(checkDependabot(root, read(root))).toEqual([]);
  });

  test("fails when bun is set but the lockfile is package-lock.json", () => {
    const root = tree({
      "package.json": "{}\n",
      "package-lock.json": "{}\n",
      ".github/dependabot.yml": config("bun"),
    });
    expect(checkDependabot(root, read(root))).toEqual([
      {
        directory: "/",
        ecosystem: "bun",
        rule: "lockfile-mismatch",
        detail: "package-lock.json is present but package-ecosystem is bun, and bun.lock is absent",
      },
    ]);
  });

  test("passes a bun copy of this repo config against the working tree", () => {
    const live = readFileSync(join(repoRoot, ".github", "dependabot.yml"), "utf8");
    const fixed = live.replace("package-ecosystem: npm", "package-ecosystem: bun");
    expect(checkDependabot(repoRoot, fixed)).toEqual([]);
  });

  test("cli exits 1 for the npm plus bun.lock tree and 0 for the corrected tree", () => {
    const broken = tree({
      "package.json": "{}\n",
      "bun.lock": "{}\n",
      ".github/workflows/ci.yml": "name: CI\n",
      ".github/dependabot.yml": config("npm"),
    });
    const failed = runCheck(broken, join(broken, ".github", "dependabot.yml"));
    expect(failed.status).toBe(1);
    expect(failed.output).toContain("dependabot config check failed");
    expect(failed.output).toContain("lockfile disagrees with package-ecosystem");

    const fixedRoot = tree({
      "package.json": "{}\n",
      "bun.lock": "{}\n",
      ".github/workflows/ci.yml": "name: CI\n",
      ".github/dependabot.yml": config("bun"),
    });
    const passed = runCheck(fixedRoot, join(fixedRoot, ".github", "dependabot.yml"));
    expect(passed.status).toBe(0);
    expect(passed.output).toBe("dependabot config check passed\n");
  });
});

function config(ecosystem: string): string {
  return `version: 2\nupdates:\n  - package-ecosystem: ${ecosystem}\n    directory: /\n    labels:\n      - dependencies\n`;
}

function read(root: string): string {
  return readFileSync(join(root, ".github", "dependabot.yml"), "utf8");
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dependabot-check-"));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}
