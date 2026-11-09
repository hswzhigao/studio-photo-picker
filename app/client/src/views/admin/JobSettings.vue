<script setup>
import { computed, inject, reactive, ref, watch } from 'vue';
import { api } from '../../api';

const ctx = inject('jobContext');
const form = reactive({ title: '', deadline_at: '', allow_preview_download: true, allow_original_download: true, allow_overage: true, overage_unit_price: 20, original_download_scope: 'selected' });
const error = ref(''), saved = ref(false), itemError = ref(''), itemMessage = ref('');
const newItem = reactive({ name: '', kind: 'print_from_retouch', quantity: 1 });
const locked = computed(() => ['locked', 'retouching', 'delivered'].includes(ctx.job?.status));
const items = computed(() => ctx.summary?.items || []);
watch(() => ctx.job, job => { if (!job) return; form.title = job.title || ''; form.deadline_at = String(job.deadline_at || '').slice(0, 16); form.allow_preview_download = Boolean(job.allow_preview_download); form.allow_original_download = Boolean(job.allow_original_download); form.allow_overage = Boolean(job.allow_overage); form.overage_unit_price = Number(job.overage_unit_price ?? 20); form.original_download_scope = job.original_download_scope || 'selected'; }, { immediate: true });
async function save() {
  try {
    await api.patch(`/api/admin/jobs/${ctx.jobId}`, { ...form, deadline_at: form.deadline_at ? new Date(form.deadline_at).toISOString() : undefined });
    saved.value = true;
    await ctx.refresh();
    setTimeout(() => { saved.value = false; }, 1500);
  } catch (e) { error.value = e.message; }
}
async function addItem() {
  itemError.value = '';
  try {
    await api.post(`/api/admin/jobs/${ctx.jobId}/items`, { ...newItem, quantity: Number(newItem.quantity) });
    newItem.name = ''; newItem.quantity = 1;
    itemMessage.value = '产品已添加';
    await ctx.refresh();
  } catch (e) { itemError.value = e.message; }
}
async function saveItem(item) {
  itemError.value = '';
  try {
    await api.patch(`/api/admin/jobs/${ctx.jobId}/items/${item.id}`, { name: item.name, kind: item.kind, quantity: Number(item.quantity) });
    itemMessage.value = '产品已保存';
    await ctx.refresh();
  } catch (e) { itemError.value = e.message; }
}
async function removeItem(item) {
  if (!window.confirm(`确定删除产品「${item.name}」？`)) return;
  itemError.value = '';
  try { await api.del(`/api/admin/jobs/${ctx.jobId}/items/${item.id}`); await ctx.refresh(); }
  catch (e) { itemError.value = e.message; }
}
</script>

<template>
  <section class="card form-card">
    <div v-if="error" class="alert danger">{{ error }}</div>
    <label>订单标题<input v-model="form.title" /></label>
    <label>截止时间<input v-model="form.deadline_at" type="datetime-local" /></label>
    <label class="inline-check"><input v-model="form.allow_preview_download" type="checkbox" /> 允许下载水印预览</label>
    <label class="inline-check"><input v-model="form.allow_original_download" type="checkbox" /> 允许下载原片</label>
    <label>原片下载范围<select v-model="form.original_download_scope"><option value="none">关闭</option><option value="selected">仅最终选片</option><option value="all">全部原片</option></select></label>
    <div class="inline-form">
      <label class="inline-check"><input v-model="form.allow_overage" type="checkbox" /> 允许加片</label>
      <label v-if="form.allow_overage">加片单价<input v-model.number="form.overage_unit_price" type="number" min="0" /></label>
    </div>
    <button class="button primary" @click="save">{{ saved ? '已保存' : '保存设置' }}</button>
  </section>
  <section class="card">
    <div class="section-head"><h2>产品行</h2><span v-if="locked" class="status">已锁定，不能修改</span></div>
    <div v-if="itemError" class="alert danger">{{ itemError }}</div>
    <div v-if="itemMessage" class="alert success">{{ itemMessage }}</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>名称</th><th>类型</th><th>数量</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td><input v-model="item.name" :disabled="locked" /></td>
            <td><select v-model="item.kind" :disabled="locked"><option value="retouch">精修</option><option value="print_from_retouch">相框 / 摆台</option></select></td>
            <td><input v-model.number="item.quantity" type="number" min="0" :disabled="locked" /></td>
            <td class="actions"><button class="button ghost small" :disabled="locked" @click="saveItem(item)">保存</button><button class="button ghost small danger-text" :disabled="locked" @click="removeItem(item)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!locked" class="inline-form item-add">
      <input v-model="newItem.name" placeholder="新产品名称" />
      <select v-model="newItem.kind"><option value="print_from_retouch">相框 / 摆台</option><option value="retouch">精修</option></select>
      <input v-model.number="newItem.quantity" type="number" min="0" />
      <button class="button ghost" @click="addItem">添加产品</button>
    </div>
  </section>
</template>
