<!--
  The AI pill: whether the wall it sits on shows videos made with AI.

  One setting behind every wall that has the pill, as the Watched pill is, and
  the same one Distraction Free settings has as a switch, so pressing it here
  hides them on search, subscriptions, channel pages and the related videos
  alike (helpers/aiShown.js). Pressed while they are shown, which is the
  default: hiding is the choice, marking is not.
-->
<template>
  <FtToggleChip
    :label="t('AI Chip.AI')"
    :icon="['fas', 'robot']"
    :pressed="shown"
    :title="t('AI Chip.Hint')"
    @toggle="toggle"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtToggleChip from '../FtToggleChip/FtToggleChip.vue'

import { aiIsShown, setAiShown } from '../../helpers/aiShown'

const { t } = useI18n()

const shown = computed(() => aiIsShown())

function toggle() {
  setAiShown(!aiIsShown())
}
</script>
