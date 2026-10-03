const path = require('path')
const { execFileSync } = require('child_process')

const REPO_ROOT = path.join(__dirname, '..')

/**
 * Identifies which build you are actually running.
 *
 * Every build of a given version otherwise looks identical, so a locally built
 * release cannot be told from the one before it, and "does this build have that
 * fix in it" has no answer. That is the question this exists to answer.
 *
 * The count is commits since the version in package.json was set, rather than a
 * date, because several builds of the same version commonly happen on one day
 * and a date cannot order them. It rises by one per commit and resets when the
 * version is bumped, so it reads as a build number within that version.
 *
 * Deliberately separate from the version string. The update check parses the
 * version numerically, and the release workflow rewrites it in place and then
 * relies on the resulting artefact filenames, so anything appended to it has to
 * survive both.
 */

/**
 * @param {string[]} args
 * @returns {string | null} trimmed output, or null if git could not answer
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    // No git, no repository, or a source tarball. Not a reason to fail a build.
    return null
  }
}

/**
 * Commits since the current version was set in package.json.
 *
 * Found by looking for the commit that introduced this exact version string,
 * which is the oldest commit that changed how many times it appears in the
 * file. Returns null when that cannot be established: a shallow clone has no
 * history to count, and the release workflow rewrites the version to something
 * that was never committed, so neither can be counted and pretending otherwise
 * would be worse than saying nothing.
 *
 * @param {string} version
 * @returns {number | null}
 */
function commitsSinceVersion(version) {
  const introducing = git([
    'log', '--format=%H', '-S', `"version": "${version}"`, '--', 'package.json'
  ])

  if (!introducing) { return null }

  // Oldest match: the commit that first brought this version string in
  const firstCommit = introducing.split('\n').filter(Boolean).pop()

  if (!firstCommit) { return null }

  const count = git(['rev-list', '--count', `${firstCommit}..HEAD`])

  if (count === null) { return null }

  const parsed = Number.parseInt(count, 10)

  return Number.isFinite(parsed) ? parsed : null
}

/**
 * A short description of the build, or an empty string when there is nothing
 * trustworthy to say. Callers should treat empty as "no stamp available" and
 * show only the version.
 *
 * @param {string} version the version from package.json
 * @returns {string} e.g. "build 12 (2d8fe1f7b)" or "2d8fe1f7b-dirty"
 */
function getBuildStamp(version) {
  const commit = git(['rev-parse', '--short', 'HEAD'])

  if (!commit) { return '' }

  // Untracked files are ignored on purpose: notes and scratch files are not
  // part of what was built. So is package.json, which the build workflow
  // rewrites with the release's version before every build, and which would
  // otherwise mark every release dirty.
  const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', '.', ':!package.json'])
  const revision = dirty ? `${commit}-dirty` : commit

  const count = commitsSinceVersion(version)

  return count === null ? revision : `build ${count} (${revision})`
}

module.exports = { getBuildStamp }
