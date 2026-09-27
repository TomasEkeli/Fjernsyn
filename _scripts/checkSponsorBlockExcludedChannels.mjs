/**
 * Checks the rules behind the SponsorBlock excluded channels list: reading the
 * setting, putting a channel on it and taking it off, and carrying the fork's
 * old never-skip list over.
 *
 * A channel on the list that should not be, or one missing from it, shows only
 * as a sponsor read that is or is not jumped past, which is easy to put down
 * to SponsorBlock itself, so the rules are pinned down here, input to output.
 *
 * Run with `pnpm run check-sponsorblock-excluded-channels`.
 */

import {
  isExcludedChannel,
  mergeMarkOnlyChannels,
  parseExcludedChannels,
  withChannelExcluded,
  withoutChannel,
} from '../src/sponsorBlockExcludedChannels.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb'
const C = 'UCcccccccccccccccccccccc'

// Reading the setting
{
  const stored = [{ name: A, preferredName: 'Alpha' }]
  check('the default is an empty list', same(parseExcludedChannels('[]'), []))
  check('a stored list comes back as it was', same(parseExcludedChannels(JSON.stringify(stored)), stored))
  check('a value that does not parse is an empty list', same(parseExcludedChannels('[{'), []))
  check('a value that is not a list is an empty list', same(parseExcludedChannels('{"name":"x"}'), []))
  check('no value is an empty list', same(parseExcludedChannels(undefined), []))
}

// Membership
{
  const list = [{ name: A, preferredName: 'Alpha' }]
  check('a listed channel is excluded', isExcludedChannel(list, A))
  check('an unlisted channel is not', !isExcludedChannel(list, B))
  check('no channel id is never excluded', !isExcludedChannel([{ name: '' }], ''))
  check('the id is matched exactly, case and all', !isExcludedChannel(list, A.toLowerCase()))
}

// Putting a channel on the list and taking it off
{
  const list = [{ name: A, preferredName: 'Alpha', icon: 'a.jpg' }]

  check('a new channel goes on the end with its name', same(
    withChannelExcluded(list, B, 'Beta'),
    [...list, { name: B, preferredName: 'Beta' }]
  ))
  check('a channel already on it is left as it was', withChannelExcluded(list, A, 'Other') === list)
  check('an empty id adds nothing', withChannelExcluded(list, '', 'Nobody') === list)
  check('taking one off leaves the rest', same(
    withoutChannel([...list, { name: B }], A),
    [{ name: B }]
  ))
  check('taking off one that is not there changes nothing', same(withoutChannel(list, C), list))
  check('the list given is never changed in place', (() => {
    const before = JSON.stringify(list)
    withChannelExcluded(list, B, 'Beta')
    withoutChannel(list, A)
    return JSON.stringify(list) === before
  })())
}

// Carrying the old never-skip list over
{
  const upstream = [{ name: A, preferredName: 'Alpha', icon: 'a.jpg', iconHref: `/channel/${A}` }]

  check('old entries are added in upstream\'s shape', same(
    mergeMarkOnlyChannels([], [{ id: B, name: 'Beta' }]),
    [{ name: B, preferredName: 'Beta' }]
  ))
  check('a channel on both lists keeps upstream\'s entry, icon and all', same(
    mergeMarkOnlyChannels(upstream, [{ id: A, name: 'Old Alpha' }, { id: B, name: 'Beta' }]),
    [...upstream, { name: B, preferredName: 'Beta' }]
  ))
  check('a name that was only the id is dropped, so the real one is looked up', same(
    mergeMarkOnlyChannels([], [{ id: C, name: C }]),
    [{ name: C, preferredName: '' }]
  ))
  check('malformed old entries are skipped', same(
    mergeMarkOnlyChannels([], [null, 'x', { name: 'no id' }, { id: 42 }, { id: B }]),
    [{ name: B, preferredName: '' }]
  ))
  check('an old value that is not a list changes nothing', mergeMarkOnlyChannels(upstream, 'nope') === upstream)
  check('an old list repeating a channel adds it once', same(
    mergeMarkOnlyChannels([], [{ id: B, name: 'Beta' }, { id: B, name: 'Beta' }]),
    [{ name: B, preferredName: 'Beta' }]
  ))
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
