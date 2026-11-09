<script setup>
import { inject, onMounted, ref } from 'vue';
import { api } from '../../api';

const ctx = inject('jobContext');
const notifications = ref([]);
const logs = ref([]);
const error = ref('');
async function load() {
  try {
    const [n, l] = await Promise.all([
      api.get(`/api/admin/jobs/${ctx.jobId}/notifications`),
      api.get(`/api/admin/audit-logs?job_id=${ctx.jobId}`),
    ]);
    notifications.value = n.notifications || [];
    logs.value = l.logs || [];
  } catch (e) { error.value = e.message; }
}
onMounted(load);
</script>

<template>
  <div>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <section class="card">
      <div class="section-head"><h2>通知</h2><button class="button ghost" @click="load">刷新</button></div>
      <ul class="log-list">
        <li v-for="item in notifications" :key="item.id"><span>{{ (item.sent_at || '').replace('T', ' ').slice(0, 16) }}</span><b>{{ item.kind }}</b><span>{{ item.content }}</span></li>
      </ul>
    </section>
    <section class="card">
      <h2>审计日志</h2>
      <ul class="log-list">
        <li v-for="item in logs" :key="item.id"><span>{{ (item.created_at || '').replace('T', ' ').slice(0, 16) }}</span><b>{{ item.action }}</b><code>{{ item.payload }}</code></li>
      </ul>
    </section>
  </div>
</template>
