<script setup lang="ts">
// The Synoikia mark, colored from theme tokens; the outer frame is dropped below 32px.
withDefaults(defineProps<{ size?: number; frame?: boolean }>(), { size: 32, frame: undefined });
</script>

<template>
  <svg
    class="brand-mark"
    viewBox="0 0 120 120"
    :width="size"
    :height="size"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <rect
      v-if="frame ?? size >= 32"
      x="4"
      y="4"
      width="112"
      height="112"
      rx="24"
      fill="none"
      class="frame"
      stroke-width="3"
      opacity="0.32"
    />
    <g class="paths" stroke-width="4" stroke-linecap="round" opacity="0.55">
      <line x1="60" y1="60" x2="60" y2="25" />
      <line x1="60" y1="60" x2="95" y2="60" />
      <line x1="60" y1="60" x2="60" y2="95" />
      <line x1="60" y1="60" x2="25" y2="60" />
    </g>
    <g class="dwellings">
      <rect x="52" y="8" width="16" height="16" rx="4" />
      <rect x="96" y="52" width="16" height="16" rx="4" />
      <rect x="52" y="96" width="16" height="16" rx="4" />
      <rect x="8" y="52" width="16" height="16" rx="4" />
    </g>
    <rect class="hearth" x="48" y="48" width="24" height="24" rx="6" />
  </svg>
</template>

<style scoped>
.brand-mark {
  display: block;
  flex: none;
}
.frame {
  stroke: var(--ink-muted, #5c5044);
}
.paths {
  stroke: var(--brand-strong, #8f3d22);
}
.dwellings {
  fill: var(--accent, #4f6b52);
}
.hearth {
  fill: var(--brand, #b5502f);
}
</style>
