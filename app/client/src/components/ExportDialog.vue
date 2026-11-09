<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api';

const props = defineProps({
  jobId: { type: Number, required: true },
  selectedIds: { type: Array, default: () => [] },
  filter: { type: String, default: 'all' },
  open: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);
const scope = ref('selected');
const groupByUse = ref(true);
const includeCsv = ref(true);
const estimate = ref({ count: 0, estimated_bytes: 0, warning: '' });
const exporting = ref(null);
const recent = ref([]);
const error = ref('');
const starting = ref(false);
let pollTimer = null;

const scopeOptions = [
  { value: 'selected', label: '已选照片（合并结果）' },
  { value: 'filter', label: '当前筛选结果' },
  { value: 'ids', label: '勾选的照片' },
  { value: 'all', label: '全部照片' },
];
const sizeText = computed(() => {
  const bytes = Number(estimate.value.estimated_bytes || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
});
const progressPercent = computed(() => exporting.value?.total ? Math.min(100, Math.round(exporting.value.progress / exporting.value.total * 100)) : 0);

async function loadEstimate() {
  try {
    const ids = scope.value === 'ids' ? props.selectedIds.join(',') : '';
    estimate.value = await api.get(`/api/admin/jobs/${props.jobId}/exports/estimate?scope=${scope.value}&filter=${encodeURIComponent(props.filter)}&ids=${encodeURIComponent(ids)}`);
  } catch (e) { estimate.value = { count: 0, estimated_bytes: 0, warning: '' }; }
}
async function loadRecent() {
  try { const data = await api.get(`/api/admin/jobs/${props.jobId}/exports`); recent.value = data.exports || []; } catch {}
}
async function start() {
  starting.value = true;
  error.value = '';
  try {
    const result = await api.post(`/api/admin/jobs/${props.jobId}/exports`, {
      scope: scope.value,
      filter: props.filter,
      ids: scope.value === 'ids' ? props.selectedIds : [],
      group_by_use: groupByUse.value,
      include_csv: includeCsv.value,
    });
    exporting.value = result.export;
    poll();
  } catch (e) { error.value = e.message; }
  finally { starting.value = false; }
}
function poll() {
  clearTimeout(pollTimer);
  if (!exporting.value || exporting.value.status !== 'pending') { loadRecent(); return; }
  pollTimer = setTimeout(async () => {
    try {
      const data = await api.get(`/api/admin/jobs/${props.jobId}/exports/${exporting.value.id}`);
      exporting.value = data.export;
      loadRecent();
      if (exporting.value.status === 'pending') poll();
    } catch (e) { error.value = e.message; }
  }, 1000);
}
function close() { clearTimeout(pollTimer); emit('close'); }
watch(() => props.open, open => { if (open) { exporting.value = null; error.value = ''; loadEstimate(); loadRecent(); } });
watch([scope, () => props.filter, () => props.selectedIds.length], () => { if (props.open) loadEstimate(); });
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="close">
    <div class="modal export-modal">
      <button class="modal-close" @click="close">×</button>
      <h2>导出原图</h2>
      <div v-if="error" class="alert danger">{{ error }}</div>
      <label>范围
        <select v-model="scope">
          <option v-for="option in scopeOptions" :key="option.value" :value="option.value" :disabled="option.value === 'ids' && !selectedIds.length">{{ option.label }}{{ option.value === 'ids' ? `（${selectedIds.length} 张）` : '' }}</option>
        </select>
      </label>
      <label class="inline-check"><input v-model="groupByUse" type="checkbox" /> 按用途分文件夹（精修 / 30寸相框 / 10寸摆台）</label>
      <label class="inline-check"><input v-model="includeCsv" type="checkbox" /> 附带修图清单.csv</label>
      <p class="muted">预计：{{ estimate.count }} 张 · {{ sizeText }}</p>
      <p v-if="estimate.warning" class="alert">{{ estimate.warning }}</p>
      <button class="button primary" :disabled="starting || !estimate.count" @click="start">{{ starting ? '正在创建…' : '开始导出' }}</button>

      <div v-if="exporting" class="export-progress">
        <p><b>{{ exporting.status === 'ready' ? '导出完成' : exporting.status === 'failed' ? '导出失败' : '正在打包' }}</b> · {{ exporting.progress || 0 }} / {{ exporting.total || 0 }} 张</p>
        <div class="progress"><i :style="{ width: progressPercent + '%' }"></i></div>
        <p v-if="exporting.missing" class="over-text">有 {{ exporting.missing }} 张原图未找到（见压缩包内 缺失文件.txt）</p>
        <a v-if="exporting.status === 'ready'" class="button primary" :href="exporting.file_url">下载 {{ exporting.export_name }}</a>
      </div>

      <details v-if="recent.length" class="recent-exports">
        <summary>最近导出（{{ recent.length }}）</summary>
        <ul>
          <li v-for="item in recent" :key="item.id">
            <span>{{ item.export_name }}</span>
            <span class="muted">{{ item.status }} · {{ item.progress || 0 }}/{{ item.total || 0 }}</span>
            <a v-if="item.status === 'ready'" :href="item.file_url">下载</a>
          </li>
        </ul>
      </details>
    </div>
  </div>
</template>
