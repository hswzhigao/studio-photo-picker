<script setup>
import { inject, reactive, ref, watch } from 'vue';
import { api } from '../../api';

const ctx = inject('jobContext');
const form = reactive({ title: '', deadline_at: '', allow_preview_download: true, allow_original_download: true, original_download_scope: 'selected' });
const error = ref(''), saved = ref(false);
watch(() => ctx.job, job => { if (!job) return; form.title = job.title || ''; form.deadline_at = String(job.deadline_at || '').slice(0, 16); form.allow_preview_download = Boolean(job.allow_preview_download); form.allow_original_download = Boolean(job.allow_original_download); form.original_download_scope = job.original_download_scope || 'selected'; }, { immediate: true });
async function save() {
  try {
    await api.patch(`/api/admin/jobs/${ctx.jobId}`, { ...form, deadline_at: form.deadline_at ? new Date(form.deadline_at).toISOString() : undefined });
    saved.value = true;
    await ctx.refresh();
    setTimeout(() => { saved.value = false; }, 1500);
  } catch (e) { error.value = e.message; }
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
    <button class="button primary" @click="save">{{ saved ? '已保存' : '保存设置' }}</button>
  </section>
</template>
