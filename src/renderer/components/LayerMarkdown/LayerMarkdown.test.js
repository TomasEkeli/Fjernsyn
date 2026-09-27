import { describe, expect, it, vi } from 'vitest'

import { mountWithApp } from '../../testing/mount'
import LayerMarkdown from './LayerMarkdown.vue'

/**
 * @param {string} source
 * @param {object} [props]
 */
function render(source, props = {}) {
  return mountWithApp(LayerMarkdown, { props: { source, baseUrl: 'https://video.example', ...props } })
}

describe('Markdown from an instance', () => {
  it('is rendered: paragraphs, emphasis, lists and links', () => {
    const wrapper = render([
      'A *short* film with **sound**.',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      'Made in [Blender](https://www.blender.org "Blender").',
    ].join('\n'))

    expect(wrapper.findAll('p')).toHaveLength(2)
    expect(wrapper.find('em').text()).toBe('short')
    expect(wrapper.find('strong').text()).toBe('sound')
    expect(wrapper.findAll('ul > li').map(item => item.text())).toEqual(['one', 'two'])
    expect(wrapper.findAll('ol > li').map(item => item.text())).toEqual(['first', 'second'])

    const link = wrapper.find('a')
    expect(link.text()).toBe('Blender')
    expect(link.attributes('href')).toBe('https://www.blender.org/')
    expect(link.attributes('title')).toBe('Blender')
  })

  it('keeps line breaks within a paragraph, as PeerTube renders them', () => {
    const wrapper = render('first line\nsecond line')

    expect(wrapper.findAll('p')).toHaveLength(1)
    expect(wrapper.findAll('br')).toHaveLength(1)
  })

  it('links bare URLs', () => {
    const link = render('See https://www.blender.org/about for more').find('a')

    expect(link.attributes('href')).toBe('https://www.blender.org/about')
  })

  it('resolves a relative link against the instance, so it never points into the app', () => {
    const link = render('[another video](/w/abc)').find('a')

    expect(link.attributes('href')).toBe('https://video.example/w/abc')
  })

  it('drops a relative link, keeping its text, when there is no instance to resolve it against', () => {
    const wrapper = render('[another video](/w/abc)', { baseUrl: '' })

    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toBe('another video')
  })

  it('shows an image as a link to it rather than loading it', () => {
    const wrapper = render('![the poster](https://video.example/poster.jpg)')

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('a').attributes('href')).toBe('https://video.example/poster.jpg')
    expect(wrapper.find('a').text()).toBe('the poster')
  })

  it('hands a click inside a link to the link itself, where the app opens it in the browser', async () => {
    const wrapper = render('[**bold link**](https://www.blender.org)')
    const link = wrapper.find('a')
    // Where the app's handler listens: above the component
    const clicked = vi.fn(event => event.preventDefault())
    document.body.addEventListener('click', clicked)
    document.body.append(wrapper.element)

    try {
      await wrapper.find('strong').trigger('click')
    } finally {
      document.body.removeEventListener('click', clicked)
      wrapper.element.remove()
    }

    expect(clicked).toHaveBeenCalledOnce()
    expect(clicked.mock.calls[0][0].target).toBe(link.element)
  })

  it('hands a middle click inside a link to the link itself, as the app handles those too', async () => {
    const wrapper = render('[**bold link**](https://www.blender.org)')
    const link = wrapper.find('a')
    const clicked = vi.fn(event => event.preventDefault())
    document.body.addEventListener('auxclick', clicked)
    document.body.append(wrapper.element)

    try {
      await wrapper.find('strong').trigger('auxclick', { button: 1 })
    } finally {
      document.body.removeEventListener('auxclick', clicked)
      wrapper.element.remove()
    }

    expect(clicked).toHaveBeenCalledOnce()
    expect(clicked.mock.calls[0][0].target).toBe(link.element)
    expect(clicked.mock.calls[0][0].button).toBe(1)
  })
})

describe('raw HTML in Markdown from an instance', () => {
  it('is shown as text, never as live HTML', () => {
    const wrapper = render([
      '<script>steal()</script>',
      '',
      '<style>body { display: none }</style>',
      '',
      'An image <img src="x" onerror="steal()"> inline',
      '',
      '<a href="javascript:steal()">raw link</a>',
      '',
      '<p style="position: fixed; inset: 0">styled</p>',
    ].join('\n'))

    const element = wrapper.element

    expect(element.querySelector('script')).toBeNull()
    expect(element.querySelector('style')).toBeNull()
    expect(element.querySelector('img')).toBeNull()
    expect(element.querySelector('[onerror]')).toBeNull()
    expect(element.querySelector('[style]')).toBeNull()
    expect(element.querySelector('a')).toBeNull()

    // What the author wrote is still there to read
    expect(wrapper.text()).toContain('<script>steal()</script>')
    expect(wrapper.text()).toContain('<img src="x" onerror="steal()">')
    expect(wrapper.text()).toContain('<p style="position: fixed; inset: 0">styled</p>')
  })

  it('cannot smuggle a javascript: link through Markdown syntax', () => {
    const wrapper = render([
      '[inline](javascript:steal())',
      '',
      '[reference][ref]',
      '',
      '<javascript:steal()>',
      '',
      '[ref]: javascript:steal()',
      '',
      '[spaced](  JavaScript:steal() )',
      '',
      '[data](data:text/html,<script>steal()</script>)',
    ].join('\n'))

    for (const link of wrapper.findAll('a')) {
      expect(link.attributes('href')).toMatch(/^https:/)
    }
    expect(wrapper.html()).not.toMatch(/href="\s*(?:javascript|data):/i)
    expect(wrapper.text()).toContain('inline')
    expect(wrapper.text()).toContain('reference')
  })

  it('cannot break out of an attribute through a link title or URL', () => {
    const wrapper = render('[x](https://video.example/a"onmouseover="steal() "t\\"onclick=\\"steal()")')

    expect(wrapper.element.querySelector('[onmouseover]')).toBeNull()
    expect(wrapper.element.querySelector('[onclick]')).toBeNull()
  })
})
