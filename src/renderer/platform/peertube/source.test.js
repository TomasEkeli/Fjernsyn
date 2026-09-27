import { describe, expect, it } from 'vitest'

import { parseSource, readSource } from './source'

describe('readSource', () => {
  it.each([
    ['https://sepiasearch.org', { host: 'sepiasearch.org', base: 'https://sepiasearch.org' }],
    ['https://sepiasearch.org/', { host: 'sepiasearch.org', base: 'https://sepiasearch.org' }],
    ['https://Tube.Example', { host: 'tube.example', base: 'https://tube.example' }],
    ['https://tube.example/sub/path/', { host: 'tube.example', base: 'https://tube.example/sub/path' }],
    ['https://sepiasearch.org/api/v1/', { host: 'sepiasearch.org', base: 'https://sepiasearch.org' }],
  ])('reads %j', (value, source) => {
    expect(readSource(value)).toEqual({ ...source, problem: null })
    expect(parseSource(value)).toEqual(source)
  })

  it.each([
    'http://tube.example',
    'ftp://tube.example',
    'https://tube.example:8443',
    'https://user:pass@tube.example',
    'https://tube.example/?q=1',
    'https://tube.example/#x',
    'https://localhost',
    'tube.example',
    '',
    null,
  ])('refuses %j as not a source', (value) => {
    expect(readSource(value)).toEqual({ problem: 'invalid' })
    expect(parseSource(value)).toBeNull()
  })

  it.each([
    'https://youtube.com',
    'https://www.youtube.com/',
    'https://m.youtube.com',
    'https://www.google.com',
  ])('refuses %j as a host that is never PeerTube', (value) => {
    expect(readSource(value)).toEqual({ problem: 'neverPeerTube', host: new URL(value).hostname })
    expect(parseSource(value)).toBeNull()
  })
})
