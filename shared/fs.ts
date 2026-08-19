// Types shared between client and server for the in-app file tree. Type-only,
// like the rest of `shared/`.

/** One entry in the file tree served by the backend. */
export interface FsEntry {
  /** Display name (last path segment). */
  name: string;
  /** Path relative to the tree root ('' for the root itself). */
  path: string;
  /** Absolute filesystem path — what a session's `cwd` is set to. */
  absolute: string;
  is_dir: boolean;
}
