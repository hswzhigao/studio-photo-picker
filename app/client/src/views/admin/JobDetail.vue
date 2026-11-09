<script setup>
import { computed, onMounted, provide, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../../api';

const route = useRoute();
const router = useRouter();
const jobId = computed(() => Number(route.params.id));
const summary = ref(null);
const jobs = ref([]);
const loading = ref(true);
const error = ref(''), actionsOpen = ref(false);
const context = reactive({ jobId: 0, job: null, summary: null, selectors: [], refresh: null });
provide('jobContext', context);

const tabs = [
  ['summary', '汇总'],
  ['photos', '照片'],
  ['selectors', '选片人'],
  ['comments', '评论'],
  ['settings', '设置'],
  ['logs', '日志'],
];
const statusLabel = computed(() => ({ draft: '草稿', selecting: '选片中', submitted: '已提交', locked: '已锁定', retouching: '修图中', delivered: '已交付' }[context.job?.status] || context.job?.status || ''));

async function refresh() {
  if (!jobId.value) return;
  loading.value = true;
  try {
    const [data, list] = await Promise.all([api.get(`/api/admin/jobs/${jobId.value}/summary`), api.get('/api/admin/jobs')]);
    summary.value = data;
    jobs.value = list.jobs || [];
    context.jobId = jobId.value;
    context.job = data.job;
    context.summary = data;
    context.selectors = data.selectors || [];
    error.value = '';
  } catch (e) { error.value = e.message || '订单加载失败'; }
  finally { loading.value = false; }
}
context.refresh = refresh;
async function action(name, body = {}) {
  try {
    const method = name === 'publish' ? 'patch' : 'post';
    await api[method](`/api/admin/jobs/${jobId.value}/${name}`, body);
    actionsOpen.value = false;
    await refresh();
  } catch (e) { error.value = e.message; }
}
function reopen() {
  const reason = window.prompt('请输入退回修改原因');
  if (reason?.trim()) action('reopen', { reason: reason.trim() });
}
function closeActions() { actionsOpen.value = false; }
function switchJob(id) { router.push(`/admin/jobs/${id}/summary`); }
function exportCsv() { window.location.href = `/api/admin/jobs/${jobId.value}/export.csv`; }
watch(jobId, () => { actionsOpen.value = false; refresh(); }, { immediate: true });
onMounted(refresh);
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <p class="eyebrow">后台 / 订单 #{{ jobId }}</p>
        <h1>{{ context.job?.title || '订单详情' }} <span class="status">{{ statusLabel }}</span></h1>
        <label>切换订单
          <select :value="jobId" @change="switchJob(Number($event.target.value))">
            <option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.title }}（#{{ job.id }}）</option>
          </select>
        </label>
      </div>
      <div class="actions job-actions">
        <button class="button ghost desktop-action" @click="refresh">刷新</button>
        <button v-if="context.job?.status === 'draft'" class="button primary" @click="action('publish')">发布</button>
        <button v-if="['selecting', 'submitted'].includes(context.job?.status)" class="button primary" @click="action('lock')">确认并锁定</button>
        <button v-if="['locked', 'retouching', 'delivered'].includes(context.job?.status)" class="button ghost" @click="reopen">退回修改</button>
        <button class="button ghost desktop-action" @click="action('remind')">提醒未提交</button>
        <button class="button ghost desktop-action" @click="action('settle')">标记已结算</button>
        <button class="button ghost desktop-action" @click="exportCsv">导出 CSV</button>
        <router-link class="button ghost desktop-action" :to="`/admin/jobs/${jobId}/photos?export=1`">导出原图</router-link>
        <button class="button ghost mobile-more" @click="actionsOpen = true">更多</button>
      </div>
    </header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div class="admin-tabs">
      <router-link v-for="[key, label] in tabs" :key="key" :to="`/admin/jobs/${jobId}/${key}`" active-class="active">{{ label }}</router-link>
    </div>
    <div v-if="loading" class="loading">正在加载订单…</div>
    <router-view v-else />
    <div v-if="actionsOpen" class="admin-drawer-backdrop" @click.self="closeActions">
      <section class="admin-drawer">
        <div class="section-head"><h2>更多操作</h2><button class="button ghost small" @click="closeActions">关闭</button></div>
        <button class="button ghost full" @click="refresh(); closeActions()">刷新</button>
        <button v-if="['locked','retouching','delivered'].includes(context.job?.status)" class="button ghost full" @click="reopen">退回修改</button>
        <button class="button ghost full" @click="action('remind')">提醒未提交</button>
        <button class="button ghost full" @click="action('settle')">标记已结算</button>
        <button class="button ghost full" @click="exportCsv(); closeActions()">导出 CSV</button>
        <button class="button ghost full" @click="router.push(`/admin/jobs/${jobId}/photos?export=1`)">导出原图</button>
      </section>
    </div>
  </div>
</template>
