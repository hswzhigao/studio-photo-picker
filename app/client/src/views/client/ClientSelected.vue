<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../../api';

const client = inject('client');
const route = useRoute();
const router = useRouter();
const jobId = computed(() => Number(route.params.id));
const job = ref(null), me = ref(null), tab = ref('mine'), photos = ref([]), packages = ref([]);
const loading = ref(true), error = ref(''), wechatHint = ref(false);
let pollTimer = null;
const locked = computed(() => ['locked', 'retouching', 'delivered'].includes(job.value?.status));
const canOriginal = computed(() => job.value?.allow_original_download && job.value?.original_download_scope !== 'none');
const previewDownloadUrl = photo => `${photo.preview_url}${photo.preview_url.includes('?') ? '&' : '?'}download=1`;

async function loadJob() {
  try {
    const data = await api.get(`/api/client/jobs/${jobId.value}`);
    job.value = data.job; me.value = data.me;
  } catch (e) { error.value = e.message; }
}
async function loadSelected() {
  loading.value = true;
  try {
    const data = await api.get(`/api/client/jobs/${jobId.value}/selected?tab=${tab.value}`);
    photos.value = data.photos || [];
    wechatHint.value = Boolean(data.wechat);
    error.value = '';
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
async function createPackage(scope) {
  try {
    const result = await api.post(`/api/client/jobs/${jobId.value}/packages`, { scope });
    packages.value.unshift(result.package);
    pollPackages();
  } catch (e) { error.value = e.message; }
}
async function pollPackages() {
  if (document.hidden) return;
  for (const item of packages.value.filter(pkg => pkg.status === 'pending')) {
    try {
      const data = await api.get(`/api/client/jobs/${jobId.value}/packages/${item.id}`);
      Object.assign(item, data.package);
    } catch {}
  }
}
function switchTab(value) { tab.value = value; loadSelected(); }
function progressPercent(pkg) { return pkg.total ? Math.round((pkg.progress || 0) / pkg.total * 100) : 0; }
function missingText(pkg) { return pkg.missing ? `有 ${pkg.missing} 张文件未找到` : ''; }
watch(jobId, () => { loadJob(); loadSelected(); }, { immediate: true });
onMounted(() => { loadJob(); loadSelected(); pollTimer = setInterval(pollPackages, 2000); });
onUnmounted(() => clearInterval(pollTimer));
</script>

<template>
  <div class="selected-page">
    <header class="page-head">
      <div><p class="eyebrow">我的选片</p><h1>{{ job?.title || '' }}</h1><p class="muted">{{ tab === 'final' ? '最终结果' : tab === 'products' ? '相框 / 摆台' : '我选的' }}</p></div>
      <div class="actions">
        <button class="button ghost" @click="router.push(`/jobs/${jobId}`)">返回选片</button>
        <button class="button ghost" @click="router.push(`/jobs/${jobId}/review`)">查看并提交</button>
      </div>
    </header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div class="filters">
      <button v-for="item in [['mine','我选的'],['final','最终结果'],['products','相框 / 摆台']]" :key="item[0]" :class="{ selected: tab === item[0] }" @click="switchTab(item[0])">{{ item[1] }}</button>
    </div>
    <p v-if="wechatHint" class="alert">请点右上角 ··· 选择“在浏览器打开”后下载，单张图可长按保存。</p>
    <div v-if="loading" class="loading">正在加载…</div>
    <div v-else-if="!photos.length" class="empty-state">这个标签下还没有照片。</div>
    <div v-else class="photo-grid selected-grid">
      <article v-for="photo in photos" :key="photo.id" class="photo-card">
        <div class="photo-image"><img :src="photo.preview_url" :alt="photo.display_name || photo.filename" loading="lazy" /></div>
        <div class="photo-footer"><span>{{ photo.display_name || photo.filename }}</span></div>
        <div class="download-actions compact">
          <a class="button ghost small" :href="previewDownloadUrl(photo)">下载预览</a>
          <a v-if="locked && canOriginal" class="button ghost small" :href="`/api/client/jobs/${jobId}/photos/${photo.id}/original`">下载原片</a>
        </div>
      </article>
    </div>
    <section class="card download-actions">
      <h2>打包下载</h2>
      <div class="actions">
        <button v-if="job?.allow_preview_download" class="button primary" @click="createPackage('selected_preview')">打包下载水印预览</button>
        <button v-if="locked && canOriginal && job?.original_download_scope === 'all'" class="button ghost" @click="createPackage('all_original')">下载全部原片</button>
        <button v-else-if="locked && canOriginal" class="button ghost" @click="createPackage('selected_original')">打包下载原片</button>
      </div>
      <div v-for="pkg in packages" :key="pkg.id" class="package-row">
        <div class="package-info"><b>{{ pkg.scope === 'selected_preview' ? '水印预览' : pkg.scope === 'all_original' ? '全部原片' : '最终选片原片' }}</b><span>{{ pkg.status === 'ready' ? '已完成' : pkg.status === 'failed' ? '失败' : '打包中' }} {{ pkg.progress || 0 }} / {{ pkg.total || 0 }} 张</span></div>
        <div class="progress"><i :style="{ width: progressPercent(pkg) + '%' }"></i></div>
        <p v-if="missingText(pkg)" class="over-text">{{ missingText(pkg) }}</p>
        <a v-if="pkg.status === 'ready'" class="button primary small" :href="pkg.file_url">下载 ZIP</a>
        <p v-if="pkg.status === 'failed'" class="over-text">打包失败，请重试。</p>
      </div>
    </section>
  </div>
</template>
