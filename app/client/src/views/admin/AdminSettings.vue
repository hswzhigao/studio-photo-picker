<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../../api';

const settings = ref(null);
const error = ref('');
async function load() {
  try { const data = await api.get('/api/admin/settings'); settings.value = data.settings; }
  catch (e) { error.value = e.message; }
}
async function backup() {
  try { const data = await api.post('/api/admin/settings/backup'); settings.value = data.backup; }
  catch (e) { error.value = e.message; }
}
onMounted(load);
</script>

<template>
  <div>
    <header class="page-head"><div><p class="eyebrow">后台 / 系统设置</p><h1>数据与备份</h1></div><button class="button primary" @click="backup">立即备份</button></header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <section class="card settings-card"><p>数据目录：<code>{{ settings?.data_dir }}</code></p><p>最近备份：{{ settings?.lastBackupAt || '尚无备份' }}</p><p>备份数量：{{ settings?.count ?? 0 }}</p></section>
  </div>
</template>
