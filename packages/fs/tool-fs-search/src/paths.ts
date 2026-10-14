/** Anchor search filenames without collapsing symlink-sensitive parent components. @module */
import * as nativePath from 'node:path'

/** Filesystem-platform path functions; no filesystem access occurs during anchoring. */
type PathDialect = Pick<typeof nativePath, 'isAbsolute' | 'parse' | 'resolve' | 'sep'>

/**
 * Preserve path components for the native realpath check, including Windows drive-relative and drive-rooted paths.
 * @param path - filename as supplied to or returned by ripgrep.
 * @param workdir - the absolute search working directory.
 * @param dialect - platform path functions; defaults to Node's host dialect.
 * @returns an absolute filename whose symlinks and parent components remain unresolved.
 */
export function absoluteSearchPath(path: string, workdir: string, dialect: PathDialect = nativePath): string {
  const root = dialect.parse(path).root
  const workdirRoot = dialect.parse(workdir).root
  if (dialect.isAbsolute(path)) {
    return (root === '/' || root === '\\') && root !== workdirRoot
      ? `${workdirRoot.slice(0, -1)}${path}`
      : path
  }
  const base = root === '' || workdirRoot.toLowerCase().includes(root.toLowerCase()) ? workdir : dialect.resolve(root)
  return `${base}${dialect.sep}${path.slice(root.length)}`
}
