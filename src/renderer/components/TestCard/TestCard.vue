<template>
  <svg
    class="testCard"
    viewBox="0 20 680 520"
    preserveAspectRatio="xMidYMid meet"
    xmlns="http://www.w3.org/2000/svg"
    role="group"
    :aria-label="`${name} ${version}`"
  >
    <defs>
      <pattern
        :id="gridId"
        width="40"
        height="40"
        x="0"
        y="20"
        patternUnits="userSpaceOnUse"
      >
        <path
          d="M0 0H40M0 40H40M0 0V40M40 0V40"
          stroke="#ececec"
          stroke-width="4"
          fill="none"
        />
      </pattern>
      <pattern
        :id="ditherId"
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
      >
        <rect
          width="6"
          height="6"
          fill="#f4f4f4"
        />
        <rect
          width="3"
          height="3"
          fill="#3a3aa0"
        />
        <rect
          x="3"
          y="3"
          width="3"
          height="3"
          fill="#3a3aa0"
        />
      </pattern>
      <clipPath :id="discId">
        <circle
          cx="340"
          cy="280"
          r="228"
        />
      </clipPath>
    </defs>

    <!--
      The grid runs on past the view box in every direction: the picture is
      fitted to the frame by its centre, and whatever room the frame has to
      spare on either side is filled by more grid.
    -->
    <rect
      x="-10000"
      y="-10000"
      width="20680"
      height="20560"
      fill="#5a5a5a"
    />
    <rect
      x="-10000"
      y="-10000"
      width="20680"
      height="20560"
      :fill="`url(#${gridId})`"
    />

    <rect
      v-for="(block, index) in SIDE_BLOCKS"
      :key="index"
      :x="block.x"
      :y="block.y"
      width="40"
      :height="block.height"
      :fill="block.fill"
    />

    <g :clip-path="`url(#${discId})`">
      <!-- The name, in a black box on white -->
      <rect
        x="112"
        y="52"
        width="456"
        height="95"
        fill="#f4f4f4"
      />
      <rect
        x="112"
        y="114"
        width="114"
        height="33"
        fill="#000"
      />
      <rect
        x="454"
        y="114"
        width="114"
        height="33"
        fill="#000"
      />

      <!-- A square wave of grey on black -->
      <rect
        x="112"
        y="147"
        width="456"
        height="35"
        fill="#000"
      />
      <rect
        v-for="x in SQUARE_WAVE"
        :key="x"
        :x="x"
        y="147"
        width="24"
        height="35"
        fill="#9c9c9c"
      />

      <!-- Colour bars -->
      <rect
        v-for="bar in COLOUR_BARS"
        :key="bar.fill"
        :x="bar.x"
        y="182"
        :width="bar.width"
        height="78"
        :fill="bar.fill"
      />

      <!-- The black band: date, centre line and clock, then the gratings -->
      <rect
        x="112"
        y="260"
        width="456"
        height="123"
        fill="#000"
      />
      <rect
        v-for="(line, index) in GRATINGS"
        :key="index"
        :x="line.x"
        y="306"
        :width="line.width"
        height="72"
        fill="#f4f4f4"
      />
      <rect
        x="324"
        y="230"
        width="32"
        height="106"
        fill="#000"
      />
      <rect
        x="272"
        y="277"
        width="136"
        height="3"
        fill="#f4f4f4"
      />
      <rect
        v-for="x in TICKS"
        :key="x"
        :x="x - 1.5"
        y="266"
        width="3"
        height="30"
        fill="#f4f4f4"
      />
      <text
        class="digits date"
        x="200"
        y="289"
      ><tspan>{{ date[0] }}</tspan><tspan dx="3">{{ date[1] }}</tspan><tspan dx="3">{{ date[2] }}</tspan></text>
      <text
        class="digits clock"
        x="480"
        y="289"
      ><tspan>{{ time[0] }}</tspan><tspan dx="3">{{ time[1] }}</tspan><tspan dx="3">{{ time[2] }}</tspan></text>

      <!-- Grey steps -->
      <rect
        v-for="step in GREY_STEPS"
        :key="step.x"
        :x="step.x"
        y="383"
        :width="step.width"
        height="39"
        :fill="step.fill ?? `url(#${ditherId})`"
      />

      <!-- The version, in a black box on white -->
      <rect
        x="112"
        y="422"
        width="456"
        height="40"
        fill="#f4f4f4"
      />

      <!-- The foot of the disc -->
      <rect
        x="112"
        y="462"
        width="456"
        height="46"
        fill="#aaa200"
      />
      <rect
        x="324"
        y="462"
        width="32"
        height="46"
        fill="#f05a5a"
      />
    </g>

    <rect
      x="248"
      y="74"
      width="184"
      height="38"
      fill="#000"
    />
    <text
      class="label identity"
      x="340"
      y="104"
      textLength="164"
      lengthAdjust="spacingAndGlyphs"
    >{{ name.toUpperCase() }}</text>

    <g class="versionBox">
      <title v-if="buildStamp">{{ buildStamp }}</title>
      <rect
        x="227"
        y="424"
        width="226"
        height="38"
        fill="#000"
      />
      <text
        class="label version"
        x="340"
        y="454"
      >{{ version }}</text>
    </g>

    <circle
      cx="340"
      cy="280"
      r="228"
      fill="none"
      stroke="#111"
      stroke-width="3"
    />

    <!--
      The links are HTML anchors over the boxes, not SVG links: the app opens
      external links from its own click handler, which honours the setting for
      them and only knows HTML anchors. They are empty so that a click lands
      on the anchor itself.
    -->
    <foreignObject
      v-if="nameUrl"
      x="248"
      y="74"
      width="184"
      height="38"
    >
      <a
        class="link nameLink"
        :href="nameUrl"
        :aria-label="name"
      />
    </foreignObject>
    <foreignObject
      v-if="versionUrl"
      x="227"
      y="424"
      width="226"
      height="38"
    >
      <a
        class="link versionLink"
        :href="versionUrl"
        :aria-label="version"
        :title="buildStamp || null"
      />
    </foreignObject>
  </svg>
</template>

<script setup>
/*
 * The test card (prøvebilde) as NRK broadcast it, after the Philips PM5544: a
 * grid with colour blocks down the sides, and a disc of bars, gratings and grey
 * steps. The name sits in the box at the top where NRK's was, the version in
 * the box at the bottom where the years were, and the disc's black band carries
 * the date on the left and a running clock on the right. There is no tone.
 *
 * Drawn on a 40 unit grid, 17 cells by 14, with the disc centred at (340, 280);
 * the bands inside the disc share the colour bars' 80 unit steps.
 *
 * It fills whatever box it is given. The view box is the disc and the side
 * blocks with a cell of grid around them, and `meet` fits that whole into the
 * box at its centre; the grid is drawn far past the view box, so the room the
 * box has to spare on either side is more grid rather than empty.
 */
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'

defineProps({
  /** Shown in capitals in the box at the top, where the broadcaster's name was */
  name: {
    type: String,
    required: true,
  },
  /** Shown in the box at the bottom, where NRK had its years */
  version: {
    type: String,
    required: true,
  },
  /** Where the name box leads; without it the box is no link */
  nameUrl: {
    type: String,
    default: null,
  },
  /** Where the version box leads; without it the box is no link */
  versionUrl: {
    type: String,
    default: null,
  },
  /** Which build this is, shown as the version box's tooltip when known */
  buildStamp: {
    type: String,
    default: null,
  },
})

const gridId = useId()
const ditherId = useId()
const discId = useId()

/** Down each side: a tall block above and below the centre, a short one at each end on the inside */
const SIDE_BLOCKS = [
  { x: 40, y: 60, height: 220, fill: '#0e9e0e' },
  { x: 40, y: 280, height: 220, fill: '#b40000' },
  { x: 80, y: 60, height: 80, fill: '#5555ff' },
  { x: 80, y: 420, height: 80, fill: '#ffa552' },
  { x: 560, y: 60, height: 80, fill: '#5555ff' },
  { x: 560, y: 420, height: 80, fill: '#ffa552' },
  { x: 600, y: 60, height: 220, fill: '#aaa200' },
  { x: 600, y: 280, height: 220, fill: '#5555ff' },
]

const SQUARE_WAVE = [-3, -2, -1, 0, 1, 2, 3].map((step) => 328 + step * 52)

const COLOUR_BARS = [
  { x: 112, width: 68, fill: '#f4f442' },
  { x: 180, width: 80, fill: '#4ef0f0' },
  { x: 260, width: 80, fill: '#52e852' },
  { x: 340, width: 80, fill: '#f052f0' },
  { x: 420, width: 80, fill: '#f05a5a' },
  { x: 500, width: 68, fill: '#1a1ab4' },
]

const TICKS = [280, 300, 320, 340, 360, 380, 400]

/** Five gratings, each finer than the last, across the middle of the black band */
const GRATINGS = [16, 10, 7, 5, 3].flatMap((period, group) => {
  const start = 180 + group * 64
  const lines = []
  for (let x = start; x + period / 2 <= start + 64; x += period) {
    lines.push({ x, width: period / 2 })
  }
  return lines
})

/** Black to white; the fifth is a dither, which has no fill of its own */
const GREY_STEPS = [
  { x: 112, width: 68, fill: '#000' },
  { x: 180, width: 80, fill: '#575757' },
  { x: 260, width: 80, fill: '#a3a3a3' },
  { x: 340, width: 80, fill: '#d2d2d2' },
  { x: 420, width: 80 },
  { x: 500, width: 68, fill: '#f4f4f4' },
]

/**
 * @param {number} value
 * @returns {string}
 */
function twoDigits(value) {
  return String(value).padStart(2, '0')
}

/**
 * @param {Date} now
 * @returns {[string, string, string]} ddMMyy, in pairs
 */
function formatDate(now) {
  return [twoDigits(now.getDate()), twoDigits(now.getMonth() + 1), twoDigits(now.getFullYear() % 100)]
}

/**
 * @param {Date} now
 * @returns {[string, string, string]} HHmmss, in pairs
 */
function formatTime(now) {
  return [twoDigits(now.getHours()), twoDigits(now.getMinutes()), twoDigits(now.getSeconds())]
}

const date = ref(formatDate(new Date()))
const time = ref(formatTime(new Date()))

/** @type {ReturnType<typeof setTimeout> | null} */
let tickTimeout = null

/**
 * Updates the date and the clock, then waits for the start of the next
 * second, so the clock turns over when the system clock does rather than up
 * to a second behind it.
 */
function tick() {
  const now = new Date()
  date.value = formatDate(now)
  time.value = formatTime(now)
  tickTimeout = setTimeout(tick, 1000 - now.getMilliseconds())
}

onMounted(tick)

onBeforeUnmount(() => {
  clearTimeout(tickTimeout)
  tickTimeout = null
})
</script>

<style scoped src="./TestCard.css" />
