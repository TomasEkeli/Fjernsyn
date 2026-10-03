// Writes the notes for a release: what reached main since the previous one.
//
//   node _scripts/releaseNotes.mjs <previous tag or ''> <this tag> [commit]
//
// The commit is what the release is of, for when its tag is not made yet;
// it defaults to the tag.
//
// Work reaches main as merges of a branch, so the notes go merge by merge,
// each branch with the subjects of its own commits. An upstream sync is named
// rather than listed: it brings in hundreds of FreeTube's commits, which are
// FreeTube's to describe. Anything committed straight on main comes last.
//
// Run by the release job in .github/workflows/build.yml, from a checkout with
// full history and tags.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPOSITORY_URL = 'https://github.com/TomasEkeli/Fjernsyn'

/**
 * @typedef {{ kind: 'merge', branch: string, commits: string[] } | { kind: 'commit', subject: string }} Entry
 */

/**
 * The branch a merge commit's subject names, in the forms git and this repo
 * write them: `Merge feature/x`, `Merge branch 'x'` (with or without
 * `into main`), and `Merge remote-tracking branch 'x' into y`.
 *
 * @param {string} subject
 * @returns {string | null}
 */
export function branchOfMerge(subject) {
  const match = /^Merge (?:(?:remote-tracking )?branch '([^']+)'|(\S+))/.exec(subject)
  return match ? (match[1] ?? match[2]) : null
}

/**
 * @param {object} release
 * @param {Entry[] | null} release.entries what reached main, oldest first; null for the first release
 * @param {string | null} release.compareUrl the diff from the previous release, if there is one
 * @returns {string} Markdown
 */
export function formatReleaseNotes({ entries, compareUrl }) {
  if (entries === null) {
    return 'The first release of Fjernsyn.\n'
  }

  if (entries.length === 0) {
    return 'No changes since the last release.\n'
  }

  const sections = []

  for (const entry of entries) {
    if (entry.kind !== 'merge') {
      continue
    }

    if (entry.branch.startsWith('sync/upstream')) {
      sections.push(['### Upstream FreeTube', '', `- FreeTube's development branch merged in (\`${entry.branch}\`)`])
    } else {
      sections.push([`### ${entry.branch}`, '', ...entry.commits.map((subject) => `- ${subject}`)])
    }
  }

  const direct = entries.filter((entry) => entry.kind === 'commit')

  if (direct.length > 0) {
    sections.push(['### Other changes', '', ...direct.map((entry) => `- ${entry.subject}`)])
  }

  if (compareUrl) {
    sections.push([`**Full changelog**: ${compareUrl}`])
  }

  return sections.map((lines) => lines.join('\n')).join('\n\n') + '\n'
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

/**
 * What reached main between the previous release and this one, merge by
 * merge, oldest first.
 *
 * @param {string} previousTag
 * @param {string} commit
 * @returns {Entry[]}
 */
function readEntries(previousTag, commit) {
  const log = git(['log', '--first-parent', '--reverse', '--format=%H%x1f%P%x1f%s', `${previousTag}..${commit}`])

  if (log === '') {
    return []
  }

  return log.split('\n').map((line) => {
    const [, parents, subject] = line.split('\x1f')
    const [first, second] = parents.split(' ')
    const branch = second ? branchOfMerge(subject) : null

    if (!branch) {
      return { kind: 'commit', subject }
    }

    const commits = git(['log', '--no-merges', '--reverse', '--format=%s', `${first}..${second}`])
    return { kind: 'merge', branch, commits: commits === '' ? [] : commits.split('\n') }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [previousTag, tag, commit = tag] = process.argv.slice(2)

  if (!tag) {
    console.error('Usage: node _scripts/releaseNotes.mjs <previous tag or \'\'> <this tag> [commit]')
    process.exit(1)
  }

  const notes = previousTag
    ? formatReleaseNotes({
        entries: readEntries(previousTag, commit),
        compareUrl: `${REPOSITORY_URL}/compare/${previousTag}...${tag}`,
      })
    : formatReleaseNotes({ entries: null, compareUrl: null })

  process.stdout.write(notes)
}
