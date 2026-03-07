import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SkillEntry, SkillSearchInput, SkillSearchResult, SkillSource } from "@t3tools/contracts";

const SKILL_CACHE_TTL_MS = 15_000;
const SKILL_SCAN_CONCURRENCY = 32;

interface CachedSkillIndex {
  scannedAt: number;
  entries: SkillEntry[];
}

const skillIndexCache = new Map<string, CachedSkillIndex>();
const inFlightSkillIndexBuilds = new Map<string, Promise<CachedSkillIndex>>();

function compareSkillEntries(left: SkillEntry, right: SkillEntry): number {
  return (
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.skillPath.localeCompare(right.skillPath)
  );
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/^\$+/, "").toLowerCase();
}

function scoreSkill(entry: SkillEntry, query: string): number {
  if (!query) {
    return 0;
  }
  const normalizedName = entry.name.toLowerCase();
  const normalizedDescription = entry.description.toLowerCase();
  if (normalizedName === query) return 0;
  if (normalizedName.startsWith(query)) return 1;
  if (normalizedName.includes(query)) return 2;
  if (normalizedDescription.includes(query)) return 3;
  return 4;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as TOutput[];
  let nextIndex = 0;

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput);
    }
  });

  await Promise.all(workers);
  return results;
}

function parseFrontmatterValue(frontmatter: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(new RegExp(`^${escapedKey}:\\s*(.+)$`, "im"));
  if (!match?.[1]) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "") || null;
}

function parseSkillMetadata(contents: string, fallbackName: string): Pick<SkillEntry, "name" | "description"> {
  const frontmatterMatch = contents.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const name = parseFrontmatterValue(frontmatter, "name") ?? fallbackName;
  const description =
    parseFrontmatterValue(frontmatter, "description") ?? `${fallbackName} skill`;
  return { name, description };
}

async function collectSkillFiles(rootDir: string): Promise<string[]> {
  const pendingDirs = [rootDir];
  const skillFiles: string[] = [];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.shift();
    if (!currentDir) continue;
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        skillFiles.push(absolutePath);
      }
    }
  }

  return skillFiles;
}

async function loadSkillEntriesFromRoot(rootDir: string, source: SkillSource): Promise<SkillEntry[]> {
  const stat = await fs.stat(rootDir).catch(() => null);
  if (!stat?.isDirectory()) {
    return [];
  }

  const skillFiles = await collectSkillFiles(rootDir);
  const entries = await mapWithConcurrency(skillFiles, SKILL_SCAN_CONCURRENCY, async (skillFile) => {
    const contents = await fs.readFile(skillFile, "utf8").catch(() => null);
    if (!contents) return null;
    const fallbackName = path.basename(path.dirname(skillFile));
    const metadata = parseSkillMetadata(contents, fallbackName);
    return {
      name: metadata.name,
      description: metadata.description,
      skillPath: skillFile,
      source,
    } satisfies SkillEntry;
  });

  return entries.filter((entry): entry is SkillEntry => entry !== null);
}

async function buildSkillIndex(homeDir: string): Promise<CachedSkillIndex> {
  const roots = [
    { source: "agents" as const, dir: path.join(homeDir, ".agents", "skills") },
    { source: "codex" as const, dir: path.join(homeDir, ".codex", "skills") },
  ];

  const deduped = new Map<string, SkillEntry>();
  for (const root of roots) {
    const entries = await loadSkillEntriesFromRoot(root.dir, root.source);
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      if (!deduped.has(key)) {
        deduped.set(key, entry);
      }
    }
  }

  const allEntries = Array.from(deduped.values()).toSorted(compareSkillEntries);
  return {
    scannedAt: Date.now(),
    entries: allEntries,
  };
}

async function getSkillIndex(): Promise<CachedSkillIndex> {
  const homeDir = os.homedir();
  const cached = skillIndexCache.get(homeDir);
  if (cached && Date.now() - cached.scannedAt < SKILL_CACHE_TTL_MS) {
    return cached;
  }

  const inFlight = inFlightSkillIndexBuilds.get(homeDir);
  if (inFlight) {
    return inFlight;
  }

  const buildPromise = buildSkillIndex(homeDir).finally(() => {
    inFlightSkillIndexBuilds.delete(homeDir);
  });
  inFlightSkillIndexBuilds.set(homeDir, buildPromise);
  const next = await buildPromise;
  skillIndexCache.set(homeDir, next);
  return next;
}

export async function searchSkillEntries(input: SkillSearchInput): Promise<SkillSearchResult> {
  const index = await getSkillIndex();
  const query = normalizeQuery(input.query);
  const matchingEntries = index.entries
    .filter((entry) => {
      if (!query) return true;
      const normalizedName = entry.name.toLowerCase();
      const normalizedDescription = entry.description.toLowerCase();
      return normalizedName.includes(query) || normalizedDescription.includes(query);
    })
    .toSorted(
      (left, right) =>
        scoreSkill(left, query) - scoreSkill(right, query) || compareSkillEntries(left, right),
    );

  return {
    entries: matchingEntries.slice(0, input.limit),
    truncated: matchingEntries.length > input.limit,
  };
}
