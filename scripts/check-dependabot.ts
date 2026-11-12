import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"] as const;
const BUN_LOCKS = ["bun.lock", "bun.lockb"] as const;

type FindingRule = "missing-manifest" | "lockfile-mismatch";

export type Finding = {
  directory: string;
  ecosystem: string;
  rule: FindingRule;
  detail: string;
};

export type DependabotUpdate = {
  ecosystem: string;
  directories: string[];
};

type ManifestRule = {
  files: readonly string[];
  scan?: (name: string) => boolean;
};

const MANIFESTS: Record<string, ManifestRule> = {
  apm: { files: ["apm.yml", "apm.lock.yaml"] },
  bazel: { files: ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"] },
  bundler: { files: ["Gemfile", "Gemfile.lock"] },
  cargo: { files: ["Cargo.toml", "Cargo.lock"] },
  composer: { files: ["composer.json", "composer.lock"] },
  conda: { files: ["environment.yml", "environment.yaml"] },
  deno: { files: ["deno.json", "deno.jsonc", "deno.lock"] },
  devcontainers: { files: ["devcontainer.json", ".devcontainer/devcontainer.json", ".devcontainer.json"] },
  docker: {
    files: ["Dockerfile", "dockerfile"],
    scan: (name) => name.startsWith("Dockerfile.") || name.endsWith(".dockerfile"),
  },
  "docker-compose": { files: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] },
  "dotnet-sdk": { files: ["global.json"] },
  elm: { files: ["elm.json"] },
  gitsubmodule: { files: [".gitmodules"] },
  gomod: { files: ["go.mod", "go.sum"] },
  gradle: { files: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle/libs.versions.toml"] },
  helm: { files: ["Chart.yaml", "Chart.yml"] },
  julia: { files: ["Project.toml", "Manifest.toml"] },
  maven: { files: ["pom.xml"] },
  mix: { files: ["mix.exs", "mix.lock"] },
  nix: { files: ["flake.nix", "flake.lock"] },
  nuget: {
    files: ["packages.config", "nuget.config", "Directory.Packages.props"],
    scan: (name) => name.endsWith(".csproj") || name.endsWith(".fsproj") || name.endsWith(".vbproj"),
  },
  opentofu: {
    files: ["terragrunt.hcl"],
    scan: (name) => name.endsWith(".tf") || name.endsWith(".tofu"),
  },
  pip: {
    files: ["pyproject.toml", "Pipfile", "Pipfile.lock", "poetry.lock", "setup.py", "setup.cfg"],
    scan: (name) => name.endsWith(".txt"),
  },
  "pre-commit": { files: [".pre-commit-config.yaml"] },
  pub: { files: ["pubspec.yaml", "pubspec.lock"] },
  "rust-toolchain": { files: ["rust-toolchain", "rust-toolchain.toml"] },
  sbt: { files: ["build.sbt"] },
  swift: { files: ["Package.swift", "Package.resolved"] },
  terraform: {
    files: ["terragrunt.hcl"],
    scan: (name) => name.endsWith(".tf"),
  },
  uv: { files: ["uv.lock", "pyproject.toml"] },
  vcpkg: { files: ["vcpkg.json"] },
};

export function parseDependabotUpdates(yaml: string): DependabotUpdate[] {
  const updates: DependabotUpdate[] = [];
  let inUpdates = false;
  let updatesIndent = 0;
  let itemIndent: number | null = null;
  let current: DependabotUpdate | null = null;
  let listIndent: number | null = null;

  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;

    if (!inUpdates) {
      if (trimmed === "updates:" || trimmed.startsWith("updates:")) {
        inUpdates = true;
        updatesIndent = indent;
      }
      continue;
    }

    if (indent <= updatesIndent && !trimmed.startsWith("- ")) {
      inUpdates = false;
      current = null;
      listIndent = null;
      continue;
    }

    if (listIndent !== null && indent > listIndent && trimmed.startsWith("- ")) {
      current?.directories.push(unquote(trimmed.slice(2).trim()));
      continue;
    }
    listIndent = null;

    if (trimmed.startsWith("- ")) {
      const newItem = itemIndent === null ? indent >= updatesIndent && indent <= updatesIndent + 2 : indent === itemIndent;
      if (newItem) {
        itemIndent = indent;
        current = { ecosystem: "", directories: [] };
        updates.push(current);
        const body = trimmed.slice(2).trim();
        if (body.startsWith("package-ecosystem:")) {
          current.ecosystem = unquote(body.slice("package-ecosystem:".length).trim());
        }
        continue;
      }
    }

    if (!current) continue;
    if (trimmed.startsWith("package-ecosystem:")) {
      current.ecosystem = unquote(trimmed.slice("package-ecosystem:".length).trim());
    } else if (trimmed.startsWith("directory:")) {
      current.directories.push(unquote(trimmed.slice("directory:".length).trim()));
    } else if (trimmed === "directories:" || trimmed.startsWith("directories:")) {
      listIndent = indent;
    }
  }

  return updates.filter((update) => update.ecosystem !== "");
}

export function checkDependabot(root: string, yaml: string): Finding[] {
  const findings: Finding[] = [];
  for (const update of parseDependabotUpdates(yaml)) {
    const directories = update.directories.length > 0 ? update.directories : [""];
    for (const directory of directories) {
      findings.push(...checkUpdateDirectory(root, update.ecosystem, directory));
    }
  }
  return findings;
}

export function runCheck(root: string, configPath: string): { status: number; output: string } {
  if (!isFile(configPath)) {
    return {
      status: 1,
      output: report([
        finding(".github", "dependabot", "missing-manifest", `${configPath} is absent`),
      ]),
    };
  }
  const findings = checkDependabot(root, readFileSync(configPath, "utf8"));
  return { status: findings.length === 0 ? 0 : 1, output: report(findings) };
}

function checkUpdateDirectory(root: string, ecosystem: string, directory: string): Finding[] {
  if (directory === "") {
    return [finding(directory, ecosystem, "missing-manifest", "directory is not set")];
  }
  const dir = directoryPath(root, directory);
  if (dir === null || !isDir(dir)) {
    return [finding(directory, ecosystem, "missing-manifest", "directory does not exist")];
  }
  if (ecosystem === "npm") return checkNpm(dir, directory);
  if (ecosystem === "bun") return checkBun(dir, directory);
  if (ecosystem === "github-actions") return checkGithubActions(dir, directory);
  const rule = MANIFESTS[ecosystem];
  if (!rule) {
    return [finding(directory, ecosystem, "missing-manifest", `no manifest rule for package-ecosystem ${ecosystem}`)];
  }
  if (!ruleMatches(dir, rule)) {
    return [finding(directory, ecosystem, "missing-manifest", `no manifest for package-ecosystem ${ecosystem}`)];
  }
  return [];
}

function checkNpm(dir: string, directory: string): Finding[] {
  const npmLocks = present(dir, NPM_LOCKS);
  const bunLocks = present(dir, BUN_LOCKS);
  const findings: Finding[] = [];
  if (!isFile(join(dir, "package.json")) && npmLocks.length === 0) {
    findings.push(
      finding(
        directory,
        "npm",
        "missing-manifest",
        "no package.json, package-lock.json, npm-shrinkwrap.json, yarn.lock, or pnpm-lock.yaml",
      ),
    );
  }
  if (bunLocks.length > 0 && npmLocks.length === 0) {
    findings.push(
      finding(
        directory,
        "npm",
        "lockfile-mismatch",
        `${bunLocks.join(" and ")} is present but package-ecosystem is npm, and no package-lock.json, yarn.lock, or pnpm-lock.yaml is present`,
      ),
    );
  }
  return findings;
}

function checkBun(dir: string, directory: string): Finding[] {
  if (isFile(join(dir, "bun.lock"))) return [];
  const npmLocks = present(dir, NPM_LOCKS);
  if (npmLocks.length > 0) {
    return [
      finding(
        directory,
        "bun",
        "lockfile-mismatch",
        `${npmLocks.join(" and ")} is present but package-ecosystem is bun, and bun.lock is absent`,
      ),
    ];
  }
  return [finding(directory, "bun", "missing-manifest", "no bun.lock")];
}

function checkGithubActions(dir: string, directory: string): Finding[] {
  const names = listNames(join(dir, ".github", "workflows"));
  const workflows = names.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  if (workflows.length === 0) {
    return [finding(directory, "github-actions", "missing-manifest", "no workflow file under .github/workflows")];
  }
  return [];
}

function ruleMatches(dir: string, rule: ManifestRule): boolean {
  if (rule.files.some((file) => isFile(join(dir, file)))) return true;
  if (!rule.scan) return false;
  return listNames(dir).some(rule.scan);
}

function present(dir: string, names: readonly string[]): string[] {
  return names.filter((name) => isFile(join(dir, name)));
}

function directoryPath(root: string, directory: string): string | null {
  const relative = directory.trim().replace(/^\/+/, "");
  if (relative === "") return root;
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return join(root, relative);
}

function listNames(path: string): string[] {
  if (!isDir(path)) return [];
  return readdirSync(path);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

function finding(directory: string, ecosystem: string, rule: FindingRule, detail: string): Finding {
  return { directory, ecosystem, rule, detail };
}

function report(findings: Finding[]): string {
  if (findings.length === 0) return "dependabot config check passed\n";
  return `dependabot config check failed\n${findings.map(formatFinding).join("\n")}\n`;
}

function formatFinding(item: Finding): string {
  return `${ruleLabel(item.rule)}: directory ${item.directory} package-ecosystem ${item.ecosystem}: ${item.detail}`;
}

function ruleLabel(rule: FindingRule): string {
  switch (rule) {
    case "missing-manifest":
      return "missing manifest";
    case "lockfile-mismatch":
      return "lockfile disagrees with package-ecosystem";
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

function parseArgs(argv: string[]): { root: string; configPath: string } {
  let root = process.cwd();
  let configPath: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[++index];
      if (!value) throw new Error("--root needs a directory");
      root = value;
      continue;
    }
    if (arg === "--config") {
      const value = argv[++index];
      if (!value) throw new Error("--config needs a file");
      configPath = value;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return { root, configPath: configPath ?? join(root, ".github", "dependabot.yml") };
}

if (import.meta.main) {
  let parsed: { root: string; configPath: string };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
  const result = runCheck(parsed.root, parsed.configPath);
  process.stdout.write(result.output);
  process.exit(result.status);
}
