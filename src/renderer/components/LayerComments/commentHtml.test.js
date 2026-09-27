import { describe, expect, it } from 'vitest'

import { vSaferHtml } from '../../directives/vSaferHtml'
import { cleanCommentHtml } from './commentHtml'

describe('cleanCommentHtml', () => {
  it('keeps a Mastodon post\'s paragraphs, breaks, mentions and shortened links', () => {
    const html = '<p>Hello <span class="h-card" translate="no"><a href="https://mastodon.social/@bob" class="u-url mention" rel="nofollow noopener" target="_blank">@<span>bob</span></a></span><br>see ' +
      '<a href="https://example.org/a/very/long/path" rel="nofollow" target="_blank"><span class="invisible">https://</span><span class="ellipsis">example.org/a/very</span><span class="invisible">/long/path</span></a></p>'

    expect(cleanCommentHtml(html)).toBe(
      '<p>Hello <span><a href="https://mastodon.social/@bob">@<span>bob</span></a></span><br>see ' +
      '<a href="https://example.org/a/very/long/path"><span class="invisible">https://</span><span class="ellipsis">example.org/a/very</span><span class="invisible">/long/path</span></a></p>'
    )
  })

  it('turns an image into its alt text, wherever it is, and drops one without', () => {
    expect(cleanCommentHtml('<div><p><font><img src="https://t.example/p.gif" alt=" wave "></font><img src="https://t.example/q.gif"></p></div>'))
      .toBe('<p>wave</p>')
  })

  it('drops elements whose content is not text, and unwraps the rest', () => {
    const html = '<p><svg><image href="https://t.example/x.png"/></svg><iframe src="https://evil.example"></iframe>' +
      '<style>body{display:none}</style><font color="red"><marquee>text</marquee></font><!-- note --></p>'

    expect(cleanCommentHtml(html)).toBe('<p>text</p>')
  })

  it('resolves a relative link against the instance, and unwraps one that is not web or mail', () => {
    expect(cleanCommentHtml('<p><a href="/w/abc">here</a> <a href="data:text/html,x">there</a> <a href="mailto:a@b.example">mail</a></p>', 'https://framatube.org'))
      .toBe('<p><a href="https://framatube.org/w/abc">here</a> there <a href="mailto:a@b.example">mail</a></p>')
  })

  it('is empty for empty text', () => {
    expect(cleanCommentHtml('')).toBe('')
    expect(cleanCommentHtml('   ')).toBe('')
  })
})

describe('cleanCommentHtml, then the lenient sanitiser, against what could load or run', () => {
  const XHTML = 'http://www.w3.org/1999/xhtml'
  const BASE = 'https://framatube.org'

  // What a cleaned comment may hold at all
  const ELEMENTS = new Set(['p', 'br', 'a', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li'])
  const LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

  /**
   * The comment as the view renders it: cut down, then through
   * `v-safer-html.lenient` (the test setup's stand-in for the native
   * sanitiser)
   *
   * @param {string} html
   */
  function render(html) {
    const element = document.createElement('div')
    vSaferHtml(element, { value: cleanCommentHtml(html, BASE), oldValue: null, modifiers: { lenient: true } })
    return element
  }

  /**
   * Fails on any element or attribute that could fetch, navigate by itself,
   * style or run anything
   *
   * @param {Element} root
   */
  function expectInert(root) {
    for (const element of root.querySelectorAll('*')) {
      expect(element.namespaceURI, element.outerHTML).toBe(XHTML)
      expect(ELEMENTS.has(element.localName), element.outerHTML).toBe(true)

      for (const { name, value } of element.attributes) {
        if (name === 'href') {
          expect(element.localName).toBe('a')
          expect(LINK_PROTOCOLS.has(new URL(value).protocol), value).toBe(true)
        } else {
          expect(name, element.outerHTML).toBe('class')
          expect(element.localName).toBe('span')
          expect(value.split(' ').every(className => className === 'invisible' || className === 'ellipsis'), value).toBe(true)
        }
      }
    }
  }

  it.each([
    ['srcset', '<p><img srcset="https://t.example/a.png 1x, https://t.example/b.png 2x" src="https://t.example/c.png" alt="pic"></p>', 'pic'],
    ['<picture><source>', '<p>a<picture><source srcset="https://t.example/a.webp" type="image/webp"><img src="https://t.example/a.png" alt="x"></picture>b</p>', 'ab'],
    ['<video poster>', '<p>a<video poster="https://t.example/p.png" src="https://t.example/v.mp4" autoplay><source src="https://t.example/v.webm"></video>b</p>', 'ab'],
    ['<input type=image>', '<p>a<input type="image" src="https://t.example/i.png" alt="x">b</p>', 'ab'],
    ['style="background:url()"', '<p style="background:url(https://t.example/bg.png)"><span style="background-image:url(https://t.example/s.png)">text</span></p>', 'text'],
    ['<style>', '<p>a<style>@import url(https://t.example/s.css); p { background: url(https://t.example/x.png) }</style>b</p>', 'ab'],
    ['<link rel=stylesheet>', '<p>a<link rel="stylesheet" href="https://t.example/s.css"><link rel="prefetch" href="https://t.example/p">b</p>', 'ab'],
    ['<meta http-equiv=refresh>', '<p>a<meta http-equiv="refresh" content="0;url=https://evil.example">b</p>', 'ab'],
    ['<base href>', '<base href="https://evil.example/"><p><a href="/w/abc">here</a></p>', 'here'],
    ['<form action>', '<p>a<form action="https://evil.example" method="post"><input name="x" value="y"><button formaction="https://evil.example/b">go</button></form>b</p>', 'ab'],
    ['target=_top', '<p><a href="https://example.org/" target="_top" rel="opener" ping="https://t.example/ping">x</a></p>', 'x'],
    ['href data:', '<p><a href="data:text/html,<script>alert(1)</script>">x</a></p>', 'x'],
    ['href javascript:', '<p><a href="javascript:alert(1)">x</a></p>', 'x'],
    ['href JaVaScRiPt: (mixed case)', '<p><a href="JaVaScRiPt:alert(1)">x</a></p>', 'x'],
    ['href javascript: after whitespace', '<p><a href="  \n javascript:alert(1)">x</a></p>', 'x'],
    ['href java<tab>script:', '<p><a href="java&#x09;script:alert(1)">x</a></p>', 'x'],
    ['href jav&#x61;script: (entity-encoded)', '<p><a href="jav&#x61;script:alert(1)">x</a></p>', 'x'],
    ['href &#106;avascript: (decimal entities)', '<p><a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a></p>', 'x'],
    ['<svg><a href>', '<p>a<svg><a href="javascript:alert(1)" xlink:href="https://t.example/x"><text>x</text></a><image href="https://t.example/i.png"/></svg>b</p>', 'ab'],
    ['<math>', '<p>a<math href="javascript:alert(1)"><mtext><a href="https://example.org">x</a></mtext><mi xlink:href="javascript:alert(1)">y</mi></math>b</p>', 'ab'],
    ['<noscript>', '<p>a<noscript><img src="https://t.example/n.png"><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>b</p>', 'ab'],
    ['<template>', '<p>a<template><img src="https://t.example/t.png"></template>b</p>', 'ab'],
    ['<xmp> with escaped text', '<p><xmp>&lt;img src=x&gt;</xmp></p>', '&lt;img src=x&gt;'],
    ['<xmp> with markup in it', '<p><xmp><img src=x onerror=alert(1)></xmp></p>', '<img src=x onerror=alert(1)>'],
    ['<iframe srcdoc>', '<p>a<iframe srcdoc="<img src=x onerror=alert(1)>" src="https://t.example/f"></iframe>b</p>', 'ab'],
    ['<object data>', '<p>a<object data="https://t.example/o.swf" type="application/x-shockwave-flash"><param name="x" value="y"></object>b</p>', 'ab'],
    ['<embed>', '<p>a<embed src="https://t.example/e.swf" type="application/x-shockwave-flash">b</p>', 'ab'],
    ['event handlers', '<p onclick="alert(1)"><b onmouseover="alert(1)">a</b><span class="invisible h-card" onfocus="alert(1)" tabindex="0">b</span></p>', 'ab'],
    ['<script>', '<p>a<script>alert(1)</script><script src="https://t.example/s.js"></script>b</p>', 'ab'],
    ['<audio> and <track>', '<p>a<audio src="https://t.example/a.mp3" autoplay><track src="https://t.example/t.vtt"></audio>b</p>', 'ab'],
    ['<frameset>', '<frameset><frame src="https://t.example/f"></frameset>', ''],
  ])('%s', (_attack, html, text) => {
    const rendered = render(html)

    expectInert(rendered)
    expect(rendered.textContent).toBe(text)
  })

  it('keeps the one link a comment may have, resolved on its instance, not on a <base>', () => {
    const rendered = render('<base href="https://evil.example/"><p><a href="/w/abc">here</a></p>')

    expect(rendered.querySelector('a').getAttribute('href')).toBe('https://framatube.org/w/abc')
  })
})
