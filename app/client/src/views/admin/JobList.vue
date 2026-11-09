<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../../api';

const jobs = ref([]);
const loading = ref(true);
const error = ref('');
const query = ref('');
const filter = ref('');

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (query.value) params.set('q', query.value);
    if (filter.value) params.set('status', filter.value);
    const data = await api.get(`/api/admin/jobs?${params}`);
    jobs.value = data.jobs || [];
    error.value = '';
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <div>
    <header class="page-head">
      <div><p class="eyebrow">后台 / 选片订单</p><h1>选片订单</h1></div>
      <div class="actions">
        <input v-model="query" placeholder="搜索订单名" @keyup.enter="load" />
        <select v-model="filter" @change="load">
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="selecting">选片中</option>
          <option value="submitted">已提交</option>
          <option value="locked">已锁定</option>
        </select>
        <button class="button ghost" @click="load">刷新</button>
        <router-link class="button primary" to="/admin/new-job">新建订单</router-link>
      </div>
    </header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div v-if="loading" class="loading">正在加载订单…</div>
    <div v-else-if="!jobs.length" class="empty-state">还没有订单。</div>
    <div v-else class="admin-job-grid">
      <router-link v-for="job in jobs" :key="job.id" class="admin-job-card" :to="`/admin/jobs/${job.id}/summary`">
        <div class="job-card-top"><span class="status">{{ job.status === 'selecting' ? '选片中' : job.status === 'locked' ? '已锁定' : job.status === 'submitted' ? '已提交' : job.status === 'draft' ? '草稿' : job.status }}</span><small>#{{ job.id }}</small></div>
        <h2>{{ job.title }}</h2>
        <p class="muted">精修 {{ job.merged_count || 0 }} 张 · 提交 {{ job.submitted_progress?.submitted || 0 }}/{{ job.submitted_progress?.total || 0 }}</p>
        <p class="muted">截止 {{ (job.deadline_at || '').slice(0, 10) }}</p>
      </router-link>
    </div>
  </div>
</template>
