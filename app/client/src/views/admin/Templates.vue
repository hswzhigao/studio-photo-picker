<script setup>
import { onMounted, reactive, ref } from 'vue';
import { api } from '../../api';

const templates = ref([]);
const error = ref('');
const form = reactive({ name: '', retouch: 20, frame: 1, desk: 1 });
async function load() {
  try { const data = await api.get('/api/admin/package-templates'); templates.value = data.templates || []; }
  catch (e) { error.value = e.message; }
}
async function create() {
  try {
    const items = [{ name: '精修照片', kind: 'retouch', quantity: Number(form.retouch) || 0 }];
    if (Number(form.frame)) items.push({ name: '30寸相框', kind: 'print_from_retouch', quantity: Number(form.frame) });
    if (Number(form.desk)) items.push({ name: '10寸摆台', kind: 'print_from_retouch', quantity: Number(form.desk) });
    await api.post('/api/admin/package-templates', { name: form.name.trim() || '套餐', items });
    form.name = '';
    await load();
  } catch (e) { error.value = e.message; }
}
onMounted(load);
</script>

<template>
  <div>
    <header class="page-head"><div><p class="eyebrow">后台 / 套餐模板</p><h1>套餐模板</h1></div></header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <section class="card"><h2>新建模板</h2><div class="inline-form"><input v-model="form.name" placeholder="模板名称" /><input v-model.number="form.retouch" type="number" min="0" placeholder="精修数量" /><input v-model.number="form.frame" type="number" min="0" placeholder="相框数量" /><input v-model.number="form.desk" type="number" min="0" placeholder="摆台数量" /><button class="button primary" @click="create">创建模板</button></div></section>
    <section class="card"><div class="table-wrap"><table><thead><tr><th>模板</th><th>内容</th></tr></thead><tbody><tr v-for="template in templates" :key="template.id"><td>{{ template.name }}</td><td>{{ (template.items || []).map(item => `${item.name}×${item.quantity}`).join('、') }}</td></tr></tbody></table></div></section>
  </div>
</template>
