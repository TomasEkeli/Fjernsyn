/**
 * Checks the platform layer's registry of shadowed and touched files, and the
 * report an upstream sync runs over it: that the committed registry is well
 * formed, that the report groups and words what it finds, and that it reads a
 * real range of this repository's own history correctly.
 *
 * A registry the report cannot read, or a report that says nothing changed
 * when something did, shows only as an upstream fix that was never ported, so
 * the rules are pinned down here. Only local git objects are read; nothing is
 * fetched.
 *
 * Run with `pnpm run check-platform-layer-registry`.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_REGISTRY_PATH,
  collectChanges,
  formatReport,
  main,
  parseRange,
  readRegistry,
  validateRegistry,
} from './reportPlatformLayerUpstream.mjs'

const SCRIPT = fileURLToPath(new URL('./reportPlatformLayerUpstream.mjs', import.meta.url))
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

let failures = 0

function check(name, body) {
  try {
    body()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message.split('\n').join('\n     ')}`)
    failures++
  }
}

const entry = (path, reason = `why ${path}`) => ({ path, reason })
const registry = (fields = {}) => ({ about: 'a registry', touched: [], shadowed: {}, ...fields })
const rejects = (value, pattern) => assert.throws(() => validateRegistry(value), pattern)

// The committed registry
check('the committed registry is well formed', () => {
  const { touched } = readRegistry(DEFAULT_REGISTRY_PATH)
  assert.ok(touched.some(file => file.path === 'package.json'), 'package.json is listed as touched')
})

// Validating a registry
check('a minimal registry is accepted and normalised', () => {
  assert.deepEqual(
    validateRegistry(registry({ touched: [entry('a.js')], shadowed: { enableX: [entry('b.vue')] } })),
    { touched: [entry('a.js')], shadowed: [{ setting: 'enableX', files: [entry('b.vue')] }] }
  )
})
check('a registry that is not an object is refused', () => rejects([], /JSON object/))
check('a missing section is refused', () => rejects({ about: 'x', touched: [] }, /shadowed: must be an object/))
check('an unknown top-level key is refused', () => rejects(registry({ shadow: {} }), /unknown key "shadow"/))
check('an empty about is refused', () => rejects(registry({ about: ' ' }), /about: must be a non-empty string/))
check('an entry without a reason is refused', () => rejects(registry({ touched: [{ path: 'a.js' }] }), /touched\[0\]\.reason/))
check('an entry with an unknown key is refused', () => rejects(registry({ touched: [{ ...entry('a.js'), note: 'x' }] }), /unknown key "note"/))
check('an absolute path is refused', () => rejects(registry({ touched: [entry('/a.js')] }), /relative/))
check('a path with ".." is refused', () => rejects(registry({ touched: [entry('src/../a.js')] }), /segments/))
check('a path listed twice in touched is refused', () => rejects(
  registry({ touched: [entry('a.js'), entry('a.js')] }),
  /touched\[1\]\.path "a\.js": already listed at touched\[0\]/
))
check('a path both touched and shadowed is refused', () => rejects(
  registry({ touched: [entry('a.js')], shadowed: { enableX: [entry('a.js')] } }),
  /shadowed\.enableX\[0\]\.path "a\.js": already listed at touched\[0\]/
))
check('a path shadowed by two switches is refused', () => rejects(
  registry({ shadowed: { enableX: [entry('a.js')], enableY: [entry('a.js')] } }),
  /already listed at shadowed\.enableX\[0\]/
))
check('a switch listing no files is refused', () => rejects(registry({ shadowed: { enableX: [] } }), /lists no files/))
check('every problem is reported at once', () => rejects(
  registry({ about: '', touched: [{ path: 'a.js' }] }),
  /about[\s\S]*touched\[0\]\.reason/
))
check('a registry that is not JSON is refused with its path', () => assert.throws(
  () => readRegistry('fixture.json', () => '{ nope'),
  /fixture\.json is not valid JSON/
))

// Reading a range
check('a two-dot range splits into its ends', () => assert.deepEqual(parseRange('abc~5..def'), { from: 'abc~5', to: 'def' }))
check('a three-dot range is refused', () => assert.throws(() => parseRange('a...b'), /<from>\.\.<to>/))
check('a range missing an end is refused', () => assert.throws(() => parseRange('a..'), /<from>\.\.<to>/))
check('a revision that looks like an option is refused', () => assert.throws(() => parseRange('--output=x..b'), /not a revision/))

// The report, from a fake git
const FROM = '1111111111111111111111111111111111111111'
const TO = '2222222222222222222222222222222222222222'
const HEAD = '3333333333333333333333333333333333333333'

function fakeGit({ commits = {}, stats = {}, missing = [] } = {}) {
  return {
    resolveCommit: (revision) => ({ HEAD, 'upstream/development': TO, from: FROM, to: TO })[revision] ?? null,
    mergeBase: () => FROM,
    existsAt: (commit, path) => commit === HEAD && !missing.includes(path),
    log: (from, to, path) => {
      assert.equal(`${from}..${to}`, `${FROM}..${TO}`)
      return commits[path] ?? []
    },
    diffStat: (_from, _to, path) => stats[path] ?? null,
  }
}

const range = { from: FROM, to: TO, description: 'a test range' }
const report = (reg, git) => formatReport(collectChanges(validateRegistry(reg), range, git))

check('a change to a touched file is listed with its reason, commits and diffstat', () => {
  const text = report(
    registry({ touched: [entry('package.json', 'dev dependencies'), entry('quiet.js')] }),
    fakeGit({
      commits: { 'package.json': ['abc1234 Bump things', 'def5678 Bump more'] },
      stats: { 'package.json': '1 file changed, 2 insertions(+), 1 deletion(-)' },
    })
  )
  const touched = text.slice(text.indexOf('Touched (expect conflicts here)'))
  assert.match(touched, /package\.json\n\s+why: dev dependencies\n\s+abc1234 Bump things\n\s+def5678 Bump more\n\s+1 file changed, 2 insertions\(\+\), 1 deletion\(-\)/)
  assert.match(touched, /1 registered file unchanged/)
  assert.doesNotMatch(touched, /quiet\.js/)
  assert.match(text, /Shadowed \(candidates to port\)\n\s+no shadowed files registered/)
  assert.match(text, /Upstream changed 1 of 2 registered files in 111111111\.\.222222222\./)
})

check('a change to a shadowed file is listed under its switch as a candidate to port', () => {
  const text = report(
    registry({ shadowed: { enableLayerHistory: [entry('src/renderer/views/History/History.vue', 'old History view')] } }),
    fakeGit({
      commits: { 'src/renderer/views/History/History.vue': ['abc1234 Fix history'] },
      stats: { 'src/renderer/views/History/History.vue': '1 file changed, 3 insertions(+)' },
    })
  )
  const shadowed = text.slice(text.indexOf('Shadowed'), text.indexOf('Touched'))
  assert.match(shadowed, /switch enableLayerHistory\n\s+src\/renderer\/views\/History\/History\.vue\n\s+why: old History view\n\s+abc1234 Fix history/)
  assert.match(text, /Touched \(expect conflicts here\)\n\s+no touched files registered/)
})

check('commits that cancel out are shown, with no net change said plainly', () => {
  const text = report(registry({ touched: [entry('a.js')] }), fakeGit({ commits: { 'a.js': ['abc1234 Add', 'def5678 Revert'] } }))
  assert.match(text, /def5678 Revert\n\s+no net change to the file over the range/)
})

check('nothing changed is said explicitly', () => {
  const text = report(
    registry({ touched: [entry('a.js'), entry('b.js')], shadowed: { enableX: [entry('c.vue')] } }),
    fakeGit()
  )
  assert.match(text, /Upstream changed none of the registered files in 111111111\.\.222222222 \(3 registered\)\./)
  assert.match(text, /switch enableX\n\s+1 registered file unchanged/)
  assert.match(text, /Touched[^\n]*\n\s+2 registered files unchanged/)
  assert.doesNotMatch(text, /Warnings/)
})

check('a registered path that is gone from HEAD is warned about', () => {
  const text = report(registry({ touched: [entry('gone.js'), entry('here.js')] }), fakeGit({ missing: ['gone.js'] }))
  assert.match(text, /Warnings\n\s+gone\.js is registered but does not exist in HEAD/)
  assert.doesNotMatch(text, /here\.js is registered/)
})

// The command line, with the fake git
function run(argv, { git = fakeGit(), files = {} } = {}) {
  let out = ''
  let err = ''
  const code = main(argv, {
    git,
    readFile: (path) => {
      if (!(path in files)) throw new Error('no such file')
      return files[path]
    },
    stdout: { write: (text) => { out += text } },
    stderr: { write: (text) => { err += text } },
  })
  return { code, out, err }
}

const fixturePath = join(REPOSITORY_ROOT, 'fixture-registry.json')
const fixtureFiles = { [fixturePath]: JSON.stringify(registry({ touched: [entry('a.js')] })) }

check('the default range is the merge base to upstream/development', () => {
  const { code, out } = run(['--registry', fixturePath], { files: fixtureFiles })
  assert.equal(code, 0)
  assert.match(out, /merge base of HEAD and upstream\/development \.\. upstream\/development/)
})
check('with no upstream/development ref it says so, and does not fetch', () => {
  const { code, err } = run(['--registry', fixturePath], {
    files: fixtureFiles,
    git: { ...fakeGit(), resolveCommit: (revision) => (revision === 'HEAD' ? HEAD : null) },
  })
  assert.equal(code, 1)
  assert.match(err, /upstream\/development is not a local ref; this script never fetches/)
})
check('a malformed registry exits non-zero', () => {
  const { code, err } = run(['--registry', fixturePath], { files: { [fixturePath]: '{"touched": 1}' } })
  assert.equal(code, 1)
  assert.match(err, /registry is malformed/)
})
check('an unknown option exits non-zero', () => assert.equal(run(['--fetch']).code, 1))
check('two ranges exit non-zero', () => assert.equal(run(['from..to', 'from..to'], { files: fixtureFiles }).code, 1))
check('a revision that names no commit exits non-zero', () => {
  const { code, err } = run(['nope..to', '--registry', fixturePath], { files: fixtureFiles })
  assert.equal(code, 1)
  assert.match(err, /"nope" does not name a commit/)
})

// The real script, against a real range of this repository's own history
const scratch = mkdtempSync(join(tmpdir(), 'platform-layer-registry-'))
try {
  const fixture = join(scratch, 'registry.json')
  writeFileSync(fixture, JSON.stringify(registry({
    touched: [
      entry('package.json', 'a line added in the range'),
      entry('src/main/index.js', 'not changed in the range'),
      entry('src/noSuchFile.js', 'never existed'),
    ],
    shadowed: {
      fixtureSwitch: [entry('src/sponsorBlockExcludedChannels.js', 'added in the range')],
    },
  })))

  const script = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--registry', fixture], {
    cwd: scratch, // the script finds the repository from its own location, not the working directory
    encoding: 'utf8',
  })

  check('a real range lists the commits and diffstat of each changed file', () => {
    const { status, stdout, stderr } = script('9bb24b31c~5..9bb24b31c')
    assert.equal(status, 0, stderr)
    assert.match(stdout, /Range: a0cbafbe2\.\.9bb24b31c/)

    const shadowed = stdout.slice(stdout.indexOf('Shadowed'), stdout.indexOf('Touched'))
    assert.match(shadowed, /switch fixtureSwitch\n\s+src\/sponsorBlockExcludedChannels\.js\n\s+why: added in the range/)
    for (const commit of ['9f02c8fa1', 'beaf78ba4', 'ec71e632f', '16486b474', '83dc28269']) {
      assert.match(shadowed, new RegExp(`${commit} `))
    }
    assert.match(shadowed, /1 file changed, 279 insertions\(\+\)/)

    const touched = stdout.slice(stdout.indexOf('Touched'))
    assert.match(touched, /package\.json\n\s+why: a line added in the range\n\s+83dc28269 Fold the never-skip list into upstream's excluded channels\n\s+1 file changed, 1 insertion\(\+\)/)
    assert.match(touched, /2 registered files unchanged/)
    assert.doesNotMatch(touched, /src\/main\/index\.js\n/)
    assert.match(stdout, /src\/noSuchFile\.js is registered but does not exist in HEAD/)
    assert.match(stdout, /Upstream changed 2 of 4 registered files in a0cbafbe2\.\.9bb24b31c\./)
  })

  check('an empty real range says nothing changed', () => {
    const { status, stdout, stderr } = script('9bb24b31c..9bb24b31c')
    assert.equal(status, 0, stderr)
    assert.match(stdout, /Upstream changed none of the registered files in 9bb24b31c\.\.9bb24b31c \(4 registered\)\./)
  })

  check('a real range with a revision that does not exist exits non-zero', () => {
    const { status, stderr } = script('9bb24b31c..no-such-revision-here')
    assert.notEqual(status, 0)
    assert.match(stderr, /"no-such-revision-here" does not name a commit/)
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
