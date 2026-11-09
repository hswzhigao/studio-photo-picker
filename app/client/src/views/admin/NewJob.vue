<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';

const router = useRouter();
const templates = ref([]);
const title = ref(''), templateId = ref(''), error = ref('');
async function load() {
  try { const data = await api.get('/api/admin/package-templates'); templates.value = data.templates || []; }
  catch (e) { error.value = e.message; }
}
async function create() {
  try {
    const result = await api.post('/api/admin/jobs', { title: title.value.trim(), template_id: templateId.value || undefined });
    router.push(`/admin/jobs/${result.job.id}/summary`);
  } catch (e) { error.value = e.message; }
}
onMounted(load);
</script>

<template>
  <div>
    <header class="page-head"><div><p class="eyebrow">后台 / 新建选片订单</p><h1>新建订单</h1></div></header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <section class="card form-card">
      <label>订单标题<input v-model="title" placeholder="例如：廖府" /></label>
      <label>套餐模板<select v-model="templateId"><option value="">不使用模板</option><option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option></select></label>
      <button class="button primary" @click="create">创建订单</button>
    </section>
  </div>
</template>
