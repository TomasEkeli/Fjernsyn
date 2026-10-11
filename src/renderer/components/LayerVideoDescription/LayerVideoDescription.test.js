import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { mountWithApp } from '../../testing/mount'
import LayerVideoDescription from './LayerVideoDescription.vue'

const MADE_WITH_AI = {
  label: 'Made with AI',
  description: 'Sounds or visuals were altered or fully generated.',
  link: { text: 'Learn more', url: 'https://support.google.com/youtube/answer/15447836?hl=en' },
  attribution: '',
}

const AUTO_DUBBED = {
  label: 'Auto-dubbed',
  description: 'Audio tracks for some languages were automatically generated.',
  link: null,
  attribution: 'Dubbed by YouTube',
}

// jsdom lays nothing out, so every description measures as short and is shown
// whole once mounted, which is when the section is shown
async function mountDescription(props) {
  const wrapper = mountWithApp(LayerVideoDescription, { props })
  await nextTick()
  return wrapper
}

describe('LayerVideoDescription, the "How this was made" section', () => {
  it('shows each disclosure in YouTube\'s words, under the description', async () => {
    const wrapper = await mountDescription({ description: 'A video.', contentDisclosures: [MADE_WITH_AI, AUTO_DUBBED] })

    const section = wrapper.find('.contentDisclosureSection')
    expect(section.find('.contentDisclosureTitle').text()).toBe('How this was made')
    expect(section.findAll('.contentDisclosureHeader').map(header => header.text())).toEqual(['Made with AI', 'Auto-dubbed'])
    expect(section.findAll('.contentDisclosureBody').map(body => body.text())).toEqual([
      'Sounds or visuals were altered or fully generated. Learn more',
      AUTO_DUBBED.description,
    ])
    // Only where YouTube gives one
    expect(section.findAll('.contentDisclosureAttribution').map(attribution => attribution.text())).toEqual(['Dubbed by YouTube'])
  })

  it('makes YouTube\'s "Learn more" a link to its help page, opened outside the app', async () => {
    const wrapper = await mountDescription({ description: 'A video.', contentDisclosures: [MADE_WITH_AI, AUTO_DUBBED] })

    const links = wrapper.findAll('.contentDisclosureBody a')
    expect(links).toHaveLength(1)
    expect(links[0].text()).toBe('Learn more')
    expect(links[0].attributes()).toMatchObject({
      href: 'https://support.google.com/youtube/answer/15447836?hl=en',
      target: '_blank',
    })
  })

  it('shows the card for the section alone, when the video has no description', async () => {
    const wrapper = await mountDescription({ description: '', contentDisclosures: [MADE_WITH_AI] })

    expect(wrapper.find('.videoDescription').exists()).toBe(true)
    expect(wrapper.find('.description').exists()).toBe(false)
    expect(wrapper.find('.contentDisclosureSection').exists()).toBe(true)
  })

  it('is not there without disclosures, and nor is the card without a description', async () => {
    expect((await mountDescription({ description: 'A video.' })).find('.contentDisclosureSection').exists()).toBe(false)
    expect((await mountDescription({ description: '', contentDisclosures: [] })).find('.videoDescription').exists()).toBe(false)
  })
})
