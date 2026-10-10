<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import type { ConfirmRequest } from '../composables/useConfirm';
import ModalDialog from './ModalDialog.vue';

const props = defineProps<{ request: ConfirmRequest }>();
const emit = defineEmits<{ done: [value: string | null] }>();

const inputId = useId();
const text = ref('');
watch(
  () => props.request,
  (r) => (text.value = r.input?.value ?? ''),
  { immediate: true },
);
</script>

<template>
  <ModalDialog :title="request.title" @close="emit('done', null)">
    <p v-if="request.message">{{ request.message }}</p>
    <div v-if="request.input" class="field">
      <label :for="inputId">{{ request.input.label }}</label>
      <input :id="inputId" v-model="text" autocomplete="off" @keydown.enter.prevent="emit('done', text)" />
    </div>
    <template #footer>
      <button class="btn" type="button" @click="emit('done', null)">Cancel</button>
      <button
        class="btn"
        :class="request.danger ? 'btn-danger' : 'btn-primary'"
        type="button"
        @click="emit('done', request.input ? text : '')"
      >
        {{ request.action ?? 'OK' }}
      </button>
    </template>
  </ModalDialog>
</template>
