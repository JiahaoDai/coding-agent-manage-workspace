import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { FsEntry } from '../../shared/fs';

/** Thrown when a requested path resolves outside the tree root. */
export class FsPathError extends Error {}

/**
 * The in-app file tree for choosing a project directory (design §10). One
 * directory is listed at a time (lazy — the client loads a level when it is
 * expanded), so a large root is never crawled up front. Everything is locked to
 * a configurable root (default: the user's home) so the client cannot wander
 * the whole disk.
 */
export class FsTree {
  constructor(readonly root: string) {}

  /** Display name of the root (e.g. the home directory's folder name). */
  rootName(): string {
    return basename(this.root) || this.root;
  }

  /**
   * Resolve a root-relative path and confirm it stays inside the root. Leading
   * separators are stripped so an absolute path can't be smuggled in; `..`
   * segments that climb above the root are rejected.
   */
  private resolve(relPath: string): string {
    const rel = relPath.replace(/^[/\\]+/, '');
    const rootBase = resolve(this.root);
    const abs = resolve(rootBase, rel);
    if (abs !== rootBase && !abs.startsWith(rootBase + sep)) {
      throw new FsPathError('path escapes the tree root');
    }
    return abs;
  }

  /** Entries directly under `relPath` ('' = the root). Dirs first, then by name; hidden entries are skipped. */
  listChildren(relPath: string): FsEntry[] {
    const abs = this.resolve(relPath);
    const entries: FsEntry[] = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = relPath ? `${relPath}/${entry.name}` : entry.name;
      entries.push({
        name: entry.name,
        path,
        absolute: join(abs, entry.name),
        is_dir: entry.isDirectory(),
      });
    }
    entries.sort((a, b) =>
      a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1,
    );
    return entries;
  }
}

/** Default root: the FS_ROOT env var, falling back to the user's home. */
export function createFsTree(): FsTree {
  return new FsTree(process.env.FS_ROOT ?? homedir());
}
