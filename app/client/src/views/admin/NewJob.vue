<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';

const router = useRouter();
const templates = ref([]);
const title = ref(''), templateId = ref('');
const form = reactive({ deadline: '', retouch: 20, frame: 1, desk: 1, download: true, scope: 'selected' });
const error = ref('');
async function load() {
  try { const data = await api.get('/api/admin/package-templates'); templates.value = data.templates || []; }
  catch (e) { error.value = e.message; }
}
async function create() {
  try {
    const items = [{ name: '精修照片', kind: 'retouch', quantity: Number(form.retouch) || 0 }, { name: '30寸相框', kind: 'print_from_retouch', quantity: Number(form.frame) || 0 }, { name: '10寸摆台', kind: 'print_from_retouch', quantity: Number(form.desk) || 0 }].filter(item => item.quantity > 0);
    const result = await api.post('/api/admin/jobs', {
      title: title.value.trim(),
      deadline_at: form.deadline ? new Date(form.deadline).toISOString() : undefined,
      allow_original_download: form.download,
      original_download_scope: form.download ? form.scope : 'none',
      items,
    });
    router.push(`/admin/jobs/${result.job.id}/photos`);
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
      <label>截止时间<input v-model="form.deadline" type="datetime-local" /></label>
      <div class="inline-form">
        <label>精修数量<input v-model.number="form.retouch" type="number" min="0" /></label>
        <label>30寸相框<input v-model.number="form.frame" type="number" min="0" /></label>
        <label>10寸摆台<input v-model.number="form.desk" type="number" min="0" /></label>
      </div>
      <label class="inline-check"><input v-model="form.download" type="checkbox" /> 允许客户下载原片</label>
      <label v-if="form.download">原片范围<select v-model="form.scope"><option value="selected">仅最终选片</option><option value="all">全部原片</option></select></label>
      <button class="button primary" @click="create">创建订单</button>
      <p class="muted">创建后可在「照片」标签导入/上传照片，在「选片人」标签添加客户。</p>
    </section>
  </div>
</template>
