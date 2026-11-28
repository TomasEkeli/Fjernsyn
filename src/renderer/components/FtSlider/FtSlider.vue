<template>
  <label
    class="pure-material-slider"
    :for="id"
    :data-settings-search-label="label"
  >
    <input
      :id="id"
      v-model.number="currentValue"
      class="input"
      :disabled="disabled"
      type="range"
      :min="minValue"
      :max="maxValue"
      :step="step"
      @change="change"
      @input="input"
    >
    <span class="label">
      {{ $t('Display Label', {label: label, value: displayLabel}) }}
    </span>
  </label>
</template>

<script setup>
import { computed, ref, useId, watch } from 'vue'

const props = defineProps({
  label: {
    type: String,
    required: true
  },
  defaultValue: {
    type: Number,
    required: true
  },
  minValue: {
    type: Number,
    required: true
  },
  maxValue: {
    type: Number,
    required: true
  },
  step: {
    type: Number,
    required: true
  },
  valueExtension: {
    type: String,
    default: null
  },
  disabled: {
    type: Boolean,
    default: false
  }
})

// `change` is the value to keep, fired when the handle is let go. `input` is
// the value under the handle while it is being dragged, for a caller that can
// show the result as it moves; it is far too frequent to save.
const emit = defineEmits(['change', 'input'])

const id = useId()
const currentValue = ref(props.defaultValue)

watch(() => props.defaultValue, (value) => {
  if (currentValue.value !== value) {
    currentValue.value = value
  }
})

const displayLabel = computed(() => {
  if (props.valueExtension === null) {
    return currentValue.value
  } else {
    return `${currentValue.value}${props.valueExtension}`
  }
})

function change() {
  emit('change', currentValue.value)
}

function input() {
  emit('input', currentValue.value)
}

</script>
<style scoped src="./FtSlider.css" />
