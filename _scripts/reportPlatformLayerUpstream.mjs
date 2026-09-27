/**
 * Reports what upstream changed in the files the platform layer work has
 * shadowed or touched (ADR-0014), so an upstream sync can see which fixes land
 * in code the new path no longer runs, and where to expect conflicts.
 *
 * The files are listed in `_scripts/platformLayerRegistry.json`. For each one
 * this prints upstream's commits and a diffstat over a range, by default from
 * the merge base of `HEAD` and `upstream/development` to `upstream/development`.
 *
 * It only reads local git objects. It never fetches and never talks to any
 * remote, so the range is only as fresh as the last fetch.
 *
 * Run with `pnpm run report-platform-layer-upstream [<from>..<to>] [--registry <path>]`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const DEFAULT_UPSTREAM = 'upstream/development'
export const DEFAULT_REGISTRY_PATH = fileURLToPath(new URL('./platformLayerRegistry.json', import.meta.url))
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

const USAGE = `Usage: node _scripts/reportPlatformLayerUpstream.mjs [<from>..<to>] [--registry <path>]

  <from>..<to>       the upstream range to report on; default is
                     $(git merge-base HEAD ${DEFAULT_UPSTREAM})..${DEFAULT_UPSTREAM}
  --registry <path>  the registry to read; default _scripts/platformLayerRegistry.json

Reads local git objects only; it never fetches.`

/** Bad input: a malformed registry, range or command line. */
export class InputError extends Error {}

const TOP_LEVEL_KEYS = ['about', 'touched', 'shadowed']
const ENTRY_KEYS = ['path', 'reason']

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

function pathProblem(path) {
  if (path.startsWith('/')) return 'must be relative to the repository root'
  if (path.startsWith('-')) return 'must not start with "-"'
  if (path.includes('\\')) return 'must use forward slashes'
  if (path.endsWith('/')) return 'must not end with "/"'
  if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    return 'must not contain empty, "." or ".." segments'
  }
  return null
}

/**
 * Checks the registry's shape and returns it normalised as
 * `{ touched: [{ path, reason }], shadowed: [{ setting, files: [{ path, reason }] }] }`,
 * or throws an InputError listing every problem found.
 */
export function validateRegistry(registry) {
  const problems = []

  if (!isPlainObject(registry)) {
    throw new InputError('registry: must be a JSON object with "about", "touched" and "shadowed"')
  }

  for (const key of Object.keys(registry)) {
    if (!TOP_LEVEL_KEYS.includes(key)) problems.push(`registry: unknown key "${key}"`)
  }
  if (!isNonEmptyString(registry.about)) problems.push('about: must be a non-empty string')

  const seen = new Map()

  function readEntries(list, where) {
    if (!Array.isArray(list)) {
      problems.push(`${where}: must be a list of { "path", "reason" }`)
      return []
    }

    const entries = []
    list.forEach((entry, index) => {
      const at = `${where}[${index}]`
      if (!isPlainObject(entry)) {
        problems.push(`${at}: must be an object with "path" and "reason"`)
        return
      }
      for (const key of Object.keys(entry)) {
        if (!ENTRY_KEYS.includes(key)) problems.push(`${at}: unknown key "${key}"`)
      }
      if (!isNonEmptyString(entry.reason)) problems.push(`${at}.reason: must be a non-empty string`)
      if (!isNonEmptyString(entry.path)) {
        problems.push(`${at}.path: must be a non-empty string`)
        return
      }

      const problem = pathProblem(entry.path)
      if (problem) {
        problems.push(`${at}.path "${entry.path}": ${problem}`)
        return
      }
      if (seen.has(entry.path)) {
        problems.push(`${at}.path "${entry.path}": already listed at ${seen.get(entry.path)}`)
        return
      }
      seen.set(entry.path, at)
      entries.push({ path: entry.path, reason: entry.reason })
    })
    return entries
  }

  const touched = readEntries(registry.touched, 'touched')

  const shadowed = []
  if (isPlainObject(registry.shadowed)) {
    for (const [setting, list] of Object.entries(registry.shadowed)) {
      if (!isNonEmptyString(setting)) {
        problems.push('shadowed: a surface switch setting name must be non-empty')
        continue
      }
      const files = readEntries(list, `shadowed.${setting}`)
      if (Array.isArray(list) && list.length === 0) {
        problems.push(`shadowed.${setting}: lists no files; list at least one or remove the switch`)
      }
      shadowed.push({ setting, files })
    }
  } else {
    problems.push('shadowed: must be an object mapping a surface switch setting name to a list of { "path", "reason" }')
  }

  if (problems.length > 0) {
    throw new InputError(`the registry is malformed:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
  }

  return { touched, shadowed }
}

/** Reads and validates a registry file. */
export function readRegistry(path, readFile = readFileSync) {
  let text
  try {
    text = readFile(path, 'utf8')
  } catch (error) {
    throw new InputError(`cannot read the registry at ${path}: ${error.message}`)
  }

  let registry
  try {
    registry = JSON.parse(text)
  } catch (error) {
    throw new InputError(`the registry at ${path} is not valid JSON: ${error.message}`)
  }

  return validateRegistry(registry)
}

/**
 * Splits `<from>..<to>` into its two revisions. Both are required, and the
 * symmetric `...` form is refused, since `git log` and `git diff` read it
 * differently.
 */
export function parseRange(text) {
  const invalid = () => new InputError(`the range "${text}" is not of the form <from>..<to>`)

  if (typeof text !== 'string' || text.includes('...')) throw invalid()
  const parts = text.split('..')
  if (parts.length !== 2) throw invalid()

  const [from, to] = parts
  if (from === '' || to === '') throw invalid()
  for (const revision of parts) {
    if (revision.startsWith('-') || /\s/.test(revision)) {
      throw new InputError(`"${revision}" in the range "${text}" is not a revision`)
    }
  }
  return { from, to }
}

/**
 * The git reads this report needs, over a function that runs git with an
 * argument list and returns its standard output (throwing on a non-zero exit).
 * Never a shell, never a remote.
 */
export function createGitReader(runGit) {
  const quietly = (args) => {
    try {
      return runGit(args)
    } catch {
      return null
    }
  }

  return {
    /** The full hash of a revision that names a commit, or null. */
    resolveCommit: (revision) => quietly(['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`])?.trim() || null,
    mergeBase: (a, b) => quietly(['merge-base', a, b])?.trim() || null,
    existsAt: (commit, path) => quietly(['cat-file', '-e', `${commit}:${path}`]) !== null,
    log: (from, to, path) => runGit(['log', '--oneline', '--no-decorate', '--no-color', `${from}..${to}`, '--', path])
      .split('\n').map(line => line.trim()).filter(line => line !== ''),
    /** The summary line of `git diff --stat`, or null when the file's content did not change. */
    diffStat: (from, to, path) => {
      const lines = runGit(['diff', '--stat', '--no-color', '--no-ext-diff', `${from}..${to}`, '--', path])
        .split('\n').map(line => line.trim()).filter(line => line !== '')
      return lines.length > 0 ? lines[lines.length - 1] : null
    },
  }
}

export function localGitReader(cwd = REPOSITORY_ROOT) {
  return createGitReader(args => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }))
}

/**
 * Works out the range to report on: the one given, or by default the merge
 * base of HEAD and upstream/development to upstream/development.
 */
export function resolveRange(rangeText, git) {
  let from, to, description
  if (rangeText === undefined) {
    const upstream = git.resolveCommit(DEFAULT_UPSTREAM)
    if (!upstream) {
      throw new InputError(`${DEFAULT_UPSTREAM} is not a local ref; this script never fetches, so fetch it first or give a range`)
    }
    const base = git.mergeBase('HEAD', upstream)
    if (!base) throw new InputError(`HEAD and ${DEFAULT_UPSTREAM} have no merge base`)
    from = base
    to = upstream
    description = `merge base of HEAD and ${DEFAULT_UPSTREAM} .. ${DEFAULT_UPSTREAM}`
  } else {
    const range = parseRange(rangeText)
    from = git.resolveCommit(range.from)
    to = git.resolveCommit(range.to)
    if (!from) throw new InputError(`"${range.from}" does not name a commit in this repository`)
    if (!to) throw new InputError(`"${range.to}" does not name a commit in this repository`)
    description = rangeText
  }
  return { from, to, description }
}

/** Collects, for every registered file, what changed in the range and whether it still exists in HEAD. */
export function collectChanges(registry, range, git) {
  const head = git.resolveCommit('HEAD')

  const describe = ({ path, reason }) => ({
    path,
    reason,
    commits: git.log(range.from, range.to, path),
    diffStat: git.diffStat(range.from, range.to, path),
    existsInHead: head ? git.existsAt(head, path) : false,
  })

  return {
    range,
    shadowed: registry.shadowed.map(({ setting, files }) => ({ setting, files: files.map(describe) })),
    touched: registry.touched.map(describe),
  }
}

const shortHash = (hash) => hash.slice(0, 9)
const hasChanges = (file) => file.commits.length > 0 || file.diffStat !== null
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

function formatFiles(files, indent) {
  const lines = []
  const changed = files.filter(hasChanges)
  const unchanged = files.length - changed.length

  for (const file of changed) {
    lines.push(`${indent}${file.path}`)
    lines.push(`${indent}  why: ${file.reason}`)
    for (const commit of file.commits) lines.push(`${indent}    ${commit}`)
    lines.push(`${indent}  ${file.diffStat ?? 'no net change to the file over the range'}`)
  }
  if (unchanged > 0) {
    lines.push(`${indent}${plural(unchanged, 'registered file', 'registered files')} unchanged`)
  }
  return lines
}

/** Formats collected changes as the report text. Pure. */
export function formatReport(data) {
  const { range } = data
  const rangeLabel = `${shortHash(range.from)}..${shortHash(range.to)}`
  const lines = [
    'Upstream changes to the platform layer\'s shadowed and touched files',
    `Range: ${rangeLabel} (${range.description})`,
    '',
    'Shadowed (candidates to port)',
  ]

  if (data.shadowed.length === 0) {
    lines.push('  no shadowed files registered')
  } else {
    for (const { setting, files } of data.shadowed) {
      lines.push(`  switch ${setting}`)
      lines.push(...formatFiles(files, '    '))
    }
  }

  lines.push('', 'Touched (expect conflicts here)')
  if (data.touched.length === 0) {
    lines.push('  no touched files registered')
  } else {
    lines.push(...formatFiles(data.touched, '  '))
  }

  const everyFile = [...data.shadowed.flatMap(({ files }) => files), ...data.touched]

  const missing = everyFile.filter(file => !file.existsInHead)
  if (missing.length > 0) {
    lines.push('', 'Warnings')
    for (const file of missing) {
      lines.push(`  ${file.path} is registered but does not exist in HEAD (renamed or deleted?); update the registry`)
    }
  }

  const changedCount = everyFile.filter(hasChanges).length
  lines.push('')
  if (changedCount === 0) {
    lines.push(`Upstream changed none of the registered files in ${rangeLabel} (${everyFile.length} registered).`)
  } else {
    lines.push(`Upstream changed ${changedCount} of ${plural(everyFile.length, 'registered file', 'registered files')} in ${rangeLabel}.`)
  }

  return lines.join('\n')
}

/**
 * Runs the report for a command line, writing to the given streams, and
 * returns the exit code: 0 on success, 1 on bad input or a failed git read.
 */
export function main(argv, {
  git = localGitReader(),
  readFile = readFileSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    let parsed
    try {
      parsed = parseArgs({
        args: argv,
        options: {
          registry: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
        strict: true,
      })
    } catch (error) {
      throw new InputError(error.message)
    }

    if (parsed.values.help) {
      stdout.write(`${USAGE}\n`)
      return 0
    }
    if (parsed.positionals.length > 1) {
      throw new InputError(`expected at most one range, got ${parsed.positionals.length}`)
    }

    const registryPath = parsed.values.registry === undefined ? DEFAULT_REGISTRY_PATH : resolve(parsed.values.registry)
    const registry = readRegistry(registryPath, readFile)
    const range = resolveRange(parsed.positionals[0], git)

    stdout.write(`${formatReport(collectChanges(registry, range, git))}\n`)
    return 0
  } catch (error) {
    if (error instanceof InputError) {
      stderr.write(`error: ${error.message}\n\n${USAGE}\n`)
    } else {
      stderr.write(`error: ${error.stderr?.toString().trim() || error.message}\n`)
    }
    return 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
