/**
 * Times the kept backup's heavy work on synthetic data shaped like Tomas's:
 * about 15,000 history entries with long descriptions, 29.6 MB of backup JSON
 * of which 27.5 MB is history and 20.3 MB the descriptions, and a few thousand
 * records in the other sections. Everything is made here from a seeded
 * pseudo-random generator; no real data is read.
 *
 * What it times is what the spec's "Where the work runs" and the startup
 * table rest on: the build (content text and its hash), the base's stringify
 * and gzip, the copy into the worker, a tick's build against a base, the
 * reading of a base, and a take in at startup.
 *
 * Run with:
 *
 *   node _scripts/timeKeptBackup.mjs
 *
 * Outside CI and not a package script on purpose: it takes tens of seconds and
 * its numbers depend on the machine. Node 22.15 or later, for the module hooks
 * below.
 */

import { registerHooks } from 'node:module'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { gunzipSync, gzipSync } from 'node:zlib'

// The sources import each other without extensions, as webpack and vitest
// allow and Node does not: try `.js` when a relative import is not found, and
// read the sources as ES modules, as the package has no "type"
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) {
        return nextResolve(`${specifier}.js`, context)
      }
      throw error
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.includes('/src/') && /\.js(\?.*)?$/.test(url)) {
      return nextLoad(url, { ...context, format: 'module' })
    }
    return nextLoad(url, context)
  },
})

const WORKER_MODULE = '../src/main/backup/keeperWorker.js'

const { runKeeperJob, sha256 } = await import(WORKER_MODULE)
const { writeBackup } = await import('../src/renderer/helpers/backup.js')
const { computeChanges, contentText, writeSyncFile } = await import('../src/renderer/helpers/keptBackup.js')
const { MACHINE_BOUND_SETTINGS } = await import('../src/main/backup/machineBound.js')

/**
 * A fresh copy of the worker module, with nothing parsed and cached: what a
 * worker started for a take in at startup has
 * @param {string} tag
 */
async function freshRunKeeperJob(tag) {
  return (await import(`${WORKER_MODULE}?fresh=${tag}`)).runKeeperJob
}

// #region synthetic data

const RUNS = 3

const HISTORY_ENTRIES = 15_000
const CHANNELS = 1_500
const SUBSCRIPTIONS = 700
const PLAYLISTS = 30
const PLAYLIST_VIDEOS = 1_200
const LATER = 100
const SEARCHES = 300
const SETTINGS = 150
const AI_VERDICTS = 2_500

/** The descriptions' mean length in characters, calibrated to give 20.3 MB */
const DESCRIPTION_MEAN = 1_440
/** YouTube's limit on a description */
const DESCRIPTION_MAX = 5_000

/** Mulberry32: small, seeded, the same sequence on every machine */
function generator(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = generator(20261007)

const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const pick = list => list[Math.floor(random() * list.length)]

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const randomString = (length, alphabet) => Array.from({ length }, () => pick(alphabet)).join('')
const videoId = () => randomString(11, BASE64URL)
const nedbId = () => randomString(16, ALPHANUMERIC)

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'ti', 'vo', 'ba', 'de', 'fi', 'go', 'ha', 'ju', 'ke', 'li', 'ma', 'no', 'pe', 'ri', 'so', 'tu', 'va', 'we', 'xo', 'ya', 'ze', 'an', 'el', 'is', 'or', 'um', 'st', 'tr', 'pl', 'gr']

const WORDS = Array.from({ length: 6_000 }, () => Array.from({ length: int(1, 4) }, () => pick(SYLLABLES)).join(''))

/** Skewed to the front, as word use is: a few words common, most rare */
const word = () => WORDS[Math.floor(WORDS.length * random() ** 2.5)]

function sentence() {
  const words = Array.from({ length: int(4, 18) }, word)
  words[0] = words[0][0].toUpperCase() + words[0].slice(1)
  return words.join(' ') + pick(['.', '.', '.', '!', '?', ':'])
}

const link = () => `https://www.example.com/${word()}/${randomString(int(6, 24), BASE64URL)}`

const timestamp = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * A description of about `length` characters: paragraphs, links, chapters,
 * and the channel's own footer, which repeats on every video of the channel
 */
function description(length, footer) {
  if (length === 0) { return '' }

  const parts = []
  let size = 0

  const add = text => {
    parts.push(text)
    size += text.length + 1
  }

  while (size < length - footer.length) {
    const kind = random()
    if (kind < 0.6) {
      add(Array.from({ length: int(1, 4) }, sentence).join(' '))
    } else if (kind < 0.75) {
      add(`${sentence()} ${link()}`)
    } else if (kind < 0.9) {
      let seconds = 0
      add(Array.from({ length: int(3, 10) }, () => {
        seconds += int(20, 400)
        return `${timestamp(seconds)} ${sentence()}`
      }).join('\n'))
    } else {
      add(Array.from({ length: int(2, 5) }, () => `#${word()}`).join(' '))
    }
  }

  return [...parts, footer].join('\n').slice(0, length)
}

/** Exponential around the mean, as most descriptions are short and a few long */
const descriptionLength = () => random() < 0.04 ? 0 : Math.min(DESCRIPTION_MAX, Math.round(-Math.log(1 - random()) * DESCRIPTION_MEAN))

const title = () => sentence().slice(0, int(20, 100))

const NOW = Date.UTC(2026, 9, 7, 12)
const DAY = 24 * 60 * 60 * 1000

const channels = Array.from({ length: CHANNELS }, () => ({
  id: `UC${randomString(22, BASE64URL)}`,
  name: Array.from({ length: int(1, 3) }, word).join(' '),
  thumbnail: `https://thumbnails.example.com/${randomString(int(60, 90), BASE64URL)}=s176-c-k-c0x00ffffff-no-rj`,
  footer: [sentence(), link(), link(), sentence()].join('\n'),
}))

/** Some channels watched far more than others */
const channel = () => channels[Math.floor(channels.length * random() ** 3)]

function historyEntry(timeWatched) {
  const from = channel()
  const lengthSeconds = int(30, 3 * 60 * 60)
  const entry = {
    _id: nedbId(),
    videoId: videoId(),
    title: title(),
    author: from.name,
    authorId: from.id,
    published: timeWatched - int(0, 3_000) * DAY,
    description: description(descriptionLength(), from.footer),
    viewCount: int(0, 50_000_000),
    lengthSeconds,
    watchProgress: random() < 0.6 ? lengthSeconds : int(0, lengthSeconds),
    timeWatched,
    isLive: false,
    type: 'video',
  }

  if (random() < 0.5) {
    entry.category = pick(['Music', 'Education', 'Gaming', 'Science & Technology', 'Entertainment', 'Film & Animation'])
  }

  if (random() < 0.15) {
    entry.lastViewedPlaylistId = `PL${randomString(32, BASE64URL)}`
    entry.lastViewedPlaylistType = 'youtube'
    entry.lastViewedPlaylistItemId = null
  }

  return entry
}

function makeSections() {
  const history = Array.from({ length: HISTORY_ENTRIES }, () => historyEntry(NOW - int(0, 6 * 365) * DAY - int(0, DAY)))

  const subscription = from => ({ id: from.id, name: from.name, thumbnail: from.thumbnail })
  const subscribed = channels.slice(0, SUBSCRIPTIONS)

  const profiles = [
    { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: subscribed.map(subscription) },
    ...Array.from({ length: 5 }, () => ({
      _id: nedbId(),
      name: word(),
      bgColor: `#${randomString(6, '0123456789ABCDEF')}`,
      textColor: '#FFFFFF',
      subscriptions: subscribed.filter(() => random() < 0.15).map(subscription),
    })),
  ]

  const playlistVideo = () => {
    const from = channel()
    return {
      videoId: videoId(),
      title: title(),
      author: from.name,
      authorId: from.id,
      lengthSeconds: int(30, 3 * 60 * 60),
      published: NOW - int(0, 3_000) * DAY,
      timeAdded: NOW - int(0, 2_000) * DAY,
      playlistItemId: uuid(),
      type: 'video',
    }
  }

  const playlists = Array.from({ length: PLAYLISTS }, (_, index) => ({
    _id: index === 0 ? 'favorites' : nedbId(),
    playlistName: index === 0 ? 'Favorites' : title(),
    protected: index === 0,
    description: index === 0 ? '' : sentence(),
    videos: Array.from({ length: Math.round(PLAYLIST_VIDEOS / PLAYLISTS * 2 * random()) }, playlistVideo),
    createdAt: NOW - int(0, 2_000) * DAY,
    lastUpdatedAt: NOW - int(0, 100) * DAY,
  }))

  const later = Array.from({ length: LATER }, (_, position) => {
    const from = channel()
    const id = videoId()
    return {
      _id: id,
      videoId: id,
      title: title(),
      author: from.name,
      authorId: from.id,
      lengthSeconds: int(30, 3 * 60 * 60),
      addedAt: NOW - int(0, 300) * DAY,
      position,
      alarm: null,
    }
  })

  const searchHistory = Array.from({ length: SEARCHES }, () => ({
    _id: Array.from({ length: int(1, 5) }, word).join(' '),
    lastUpdatedAt: NOW - int(0, 1_000) * DAY,
  }))

  const settings = Array.from({ length: SETTINGS }, (_, index) => ({
    _id: `syntheticSetting${String(index).padStart(3, '0')}`,
    value: pick([true, false, int(0, 1_000), word(), `${word()} ${word()}`]),
  }))

  const channelRecords = channels.map(from => ({
    _id: from.id,
    name: from.name,
    thumbnail: from.thumbnail,
    handle: `@${from.name.replaceAll(' ', '')}`,
    checkedAt: NOW - int(0, 300) * DAY,
  }))

  const aiVerdicts = Array.from({ length: AI_VERDICTS }, () => ({
    _id: videoId(),
    ai: random() < 0.05,
    checkedAt: NOW - int(0, 300) * DAY,
  }))

  return { profiles, history, playlists, later, searchHistory, settings, channels: channelRecords, aiVerdicts }
}

function uuid() {
  const hex = randomString(32, '0123456789abcdef')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

/**
 * A copy of the sections with history changed as watching would: `count`
 * entries watched again, with new progress and time, and `added` new ones
 */
function watched(sections, count, added) {
  const history = [...sections.history]

  for (let index = 0; index < count; index++) {
    const at = Math.floor(index * history.length / count)
    history[at] = { ...history[at], watchProgress: history[at].watchProgress + 17, timeWatched: NOW + index * 60_000 }
  }

  for (let index = 0; index < added; index++) {
    history.push(historyEntry(NOW + (count + index) * 60_000))
  }

  return { ...sections, history }
}

// #endregion synthetic data

// #region measuring

const results = []

const mb = bytes => `${(bytes / 1e6).toFixed(2)} MB`

/**
 * Runs `fn` RUNS times (or `runs`), printing every time and the median
 * @template T
 * @param {string} label
 * @param {(run: number) => T | Promise<T>} fn
 * @returns {Promise<T>} the last run's result
 */
async function time(label, fn, runs = RUNS) {
  const times = []
  let result

  for (let run = 0; run < runs; run++) {
    const started = performance.now()
    result = await fn(run)
    times.push(performance.now() - started)
  }

  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]
  results.push({ label, median })
  console.log(`${label.padEnd(58)} ${String(Math.round(median)).padStart(6)} ms   (${times.map(t => Math.round(t)).join(', ')})`)

  return result
}

/** A worker that answers each message once it has it, deserialised */
function echoWorker() {
  const worker = new Worker(
    "const { parentPort } = require('node:worker_threads'); parentPort.on('message', message => parentPort.postMessage(typeof message))",
    { eval: true }
  )
  return {
    send: message => new Promise(resolve => {
      worker.once('message', resolve)
      worker.postMessage(message)
    }),
    stop: () => worker.terminate(),
  }
}

// #endregion measuring

const header = { appVersion: '0.1.0', installationId: 'synthetic-installation', machineName: 'this-machine' }

console.log(`Node ${process.version}, ${process.platform} ${process.arch}`)
console.log('Making synthetic data...')

const sections = makeSections()

const baseText = writeBackup({ ...header, sections })
const historyText = JSON.stringify({ history: sections.history }, null, 2)
const descriptionBytes = sections.history.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.description)), 0)
const otherRecords = Object.entries(sections).filter(([name]) => name !== 'history')
  .map(([name, records]) => `${name} ${records.length} (${mb(Buffer.byteLength(JSON.stringify({ [name]: records }, null, 2)))})`).join(', ')

console.log(`\nBackup JSON ${mb(Buffer.byteLength(baseText))}, history ${mb(Buffer.byteLength(historyText))} (${sections.history.length} entries), descriptions ${mb(descriptionBytes)}`)
console.log(`Other sections: ${otherRecords}`)
console.log('(MB is 10^6 bytes; the spec\'s targets: 29.6 MB, 27.5 MB, 20.3 MB, gzipped 10.3 MB)\n')

// The build's first step, every tick that has something changed
await time('contentText + sha256 (the build\'s content hash)', () => sha256(contentText(sections)))

await time('writeBackup (stringify of a base)', () => writeBackup({ ...header, sections }))

const gz = await time('gzip, default level', () => gzipSync(baseText))
console.log(`${''.padEnd(58)} ${mb(gz.length)} gzipped, ${(gz.length / Buffer.byteLength(baseText) * 100).toFixed(1)}% of the JSON`)

await time('sha256 of the base text', () => sha256(baseText))

await time('structuredClone of the sections (the copy into the worker)', () => structuredClone(sections))

const echo = echoWorker()
await echo.send('warm-up')
await time('postMessage of the sections to a worker and its answer', () => echo.send(sections))
await time('postMessage of the base text to a worker and its answer', () => echo.send(baseText))
await echo.stop()

await time('JSON.parse of the base text', () => JSON.parse(baseText))

const baseHash = sha256(baseText)
const base = { file: `base-${baseHash.slice(0, 16)}.json.gz`, sha256: baseHash, text: baseText }
const baseContentHash = sha256(contentText(sections))

// A tick: one entry watched further and one new one, against the base
const tick = watched(sections, 1, 1)
const buildJob = { type: 'build', sections: tick, header, base, lastContentHash: baseContentHash }

{
  // Each run a fresh copy of the worker, with no parsed base cached
  const fresh = await Promise.all(Array.from({ length: RUNS }, (_, run) => freshRunKeeperJob(`cold-build-${run}`)))
  const result = await time('tick build against the base, cold (base parsed)', run => fresh[run](buildJob))
  console.log(`${''.padEnd(58)} sync file ${result.syncText.length} chars, rebase ${result.newBase !== null}`)
}

runKeeperJob(buildJob)
await time('tick build against the base, warm (parsed base cached)', () => runKeeperJob(buildJob))

await time('build with no base (the first write or a rebase, with gzip)', () => runKeeperJob({ ...buildJob, base: null }))

await time('gunzip + sha256 of the base (readBase, on main)', () => sha256(gunzipSync(gz).toString('utf8')))

// Fifty entries watched since the base, as a day or two of watching
const fifty = watched(sections, 50, 0)
const fiftySync = writeSyncFile({ ...header, base: { file: base.file, sha256: base.sha256 }, changes: computeChanges(sections, fifty) })
console.log(`\nSync file for 50 changed history entries: ${fiftySync.length} chars (${(fiftySync.length / 1024).toFixed(0)} KiB)`)

const oneHundredAdded = watched(sections, 0, 100)
const addedSync = writeSyncFile({ ...header, base: { file: base.file, sha256: base.sha256 }, changes: computeChanges(sections, oneHundredAdded) })
console.log(`Sync file for 100 new history entries: ${addedSync.length} chars (${(addedSync.length / 1024).toFixed(0)} KiB)\n`)

// A take in at startup: the other machine wrote a base and 50 changes on it,
// and this machine's data differs from both
{
  const otherBaseText = writeBackup({ ...header, machineName: 'other-machine', sections })
  const otherHash = sha256(otherBaseText)
  const otherGz = gzipSync(otherBaseText)
  const syncText = writeSyncFile({
    ...header,
    machineName: 'other-machine',
    base: { file: `base-${otherHash.slice(0, 16)}.json.gz`, sha256: otherHash },
    changes: computeChanges(sections, fifty),
  })

  const local = watched(sections, 3, 2)
  const takeInJob = { type: 'prepareTakeIn', syncText, baseText: otherBaseText, sections: local, header, machineBound: [...MACHINE_BOUND_SETTINGS] }

  await time('take in: gunzip + sha256 of the other base (on main)', () => sha256(gunzipSync(otherGz).toString('utf8')))
  await time('take in: structuredClone of the job (sections + base text)', () => structuredClone(takeInJob))

  const fresh = await Promise.all(Array.from({ length: RUNS }, (_, run) => freshRunKeeperJob(`take-in-${run}`)))
  const prepared = await time('take in: prepareTakeIn in a fresh worker', run => fresh[run](takeInJob))

  if (!prepared.ok) {
    console.log(`prepareTakeIn refused: ${prepared.reason}`)
    process.exit(1)
  }

  await time('take in: structuredClone of the result (the copy back)', () => structuredClone(prepared))
  console.log(`${''.padEnd(58)} safety copy ${mb(Buffer.byteLength(prepared.safetyCopy))}`)
}

const median = label => results.find(result => result.label.startsWith(label)).median

const startup = median('take in: gunzip') + median('take in: structuredClone of the job') +
  median('take in: prepareTakeIn') + median('take in: structuredClone of the result')

console.log(`\nA take in at startup, before restoreBackup's datastore writes and the safety copy's write: about ${Math.round(startup)} ms`)
