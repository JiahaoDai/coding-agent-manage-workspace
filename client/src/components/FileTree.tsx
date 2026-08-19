import { useCallback, useEffect, useState } from 'react';
import { listFsChildren } from '../api';
import type { FsEntry } from '../types';

function Chevron({ dir, open }: { dir: boolean; open: boolean }) {
  return (
    <span
      className={`file-chevron${dir ? ' is-dir' : ''}${open ? ' is-open' : ''}`}
      aria-hidden="true"
    >
      {dir && (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      )}
    </span>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

interface TreeNodeProps {
  entry: FsEntry;
  depth: number;
  loaded: Record<string, FsEntry[]>;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  selected: string | null;
  onPick: (entry: FsEntry) => void;
}

function TreeNode({ entry, depth, loaded, expanded, loading, selected, onPick }: TreeNodeProps) {
  const isDir = entry.is_dir;
  const isOpen = expanded.has(entry.path);
  return (
    <>
      <button
        type="button"
        className={`file-node${selected === entry.path ? ' is-selected' : ''}${isDir ? ' is-dir' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onPick(entry)}
        disabled={!isDir}
        title={isDir ? entry.absolute : entry.name}
      >
        <Chevron dir={isDir} open={isOpen} />
        <span className="file-node-icon" aria-hidden="true">
          {isDir ? <FolderIcon /> : <FileIcon />}
        </span>
        <span className="file-node-name">{entry.name}</span>
      </button>
      {isDir && isOpen && (loaded[entry.path] ?? []).map((child) => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          loaded={loaded}
          expanded={expanded}
          loading={loading}
          selected={selected}
          onPick={onPick}
        />
      ))}
      {isDir && isOpen && loading.has(entry.path) && (
        <div className="file-node-loading" style={{ paddingLeft: `${(depth + 1) * 16 + 20}px` }}>
          Loading…
        </div>
      )}
    </>
  );
}

/**
 * A lazily-loaded file tree. Directories expand on click (loading their
 * children on first open) and are reported to the parent via `onSelect`, which
 * is what the caller uses to pick a working directory. Files are shown for
 * orientation but aren't selectable.
 */
export function FileTree({
  root,
  onSelect,
}: {
  /** The root directory: its display name and absolute path. */
  root: { name: string; absolute: string };
  onSelect: (entry: FsEntry) => void;
}) {
  const [loaded, setLoaded] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['']));
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setLoading((prev) => new Set(prev).add(path));
    setError(null);
    try {
      const entries = await listFsChildren(path);
      setLoaded((prev) => ({ ...prev, [path]: entries }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  // Load the root's children on mount (root path is '').
  useEffect(() => {
    void load('');
  }, [load]);

  function handlePick(entry: FsEntry) {
    if (!entry.is_dir) return;
    setSelected(entry.path);
    onSelect(entry);
    // Expand on click and lazy-load the children the first time.
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!loaded[entry.path]) void load(entry.path);
  }

  const rootEntry: FsEntry = { name: root.name, path: '', absolute: root.absolute, is_dir: true };

  return (
    <div className="file-tree">
      <button
        type="button"
        className={`file-node file-node-root${selected === '' ? ' is-selected' : ''}`}
        onClick={() => handlePick(rootEntry)}
        title={root.absolute}
      >
        <Chevron dir open={expanded.has('')} />
        <span className="file-node-icon" aria-hidden="true">
          <FolderIcon />
        </span>
        <span className="file-node-name">{root.name}</span>
      </button>
      {expanded.has('') &&
        (loaded[''] ?? []).map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={1}
            loaded={loaded}
            expanded={expanded}
            loading={loading}
            selected={selected}
            onPick={handlePick}
          />
        ))}
      {expanded.has('') && loading.has('') && (
        <div className="file-node-loading" style={{ paddingLeft: '20px' }}>
          Loading…
        </div>
      )}
      {error && (
        <p className="file-tree-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
