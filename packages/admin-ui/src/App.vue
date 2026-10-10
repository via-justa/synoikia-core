<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query';
import { watch } from 'vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import { provideConfirm } from './composables/useConfirm';
import { useSessionStore } from './stores/session';

const queryClient = useQueryClient();
const session = useSessionStore();
const { request, settle } = provideConfirm();

// Cached server data belongs to the signed-in user: sign-out, a lost session or another sign-in drops it.
watch(
  () => session.user?.id,
  () => queryClient.clear(),
);
</script>

<template>
  <RouterView />
  <ConfirmDialog v-if="request" :request="request" @done="settle" />
</template>
