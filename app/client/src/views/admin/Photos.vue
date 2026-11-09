<script setup>
import { computed, inject, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PhotoManager from '../../components/PhotoManager.vue';
import ExportDialog from '../../components/ExportDialog.vue';

const ctx = inject('jobContext');
const route = useRoute();
const router = useRouter();
const selectedIds = ref([]);
const exportOpen = ref(false);
const filter = computed(() => String(route.query.filter || 'all'));

function setFilter(value) {
  const query = { ...route.query, filter: value };
  if (!value || value === 'all') delete query.filter;
  router.replace({ query });
}
function setSelection(ids) { selectedIds.value = ids; }
onMounted(() => { if (String(route.query.export || '') === '1') exportOpen.value = true; });
watch(() => route.query.export, value => { if (String(value || '') === '1') exportOpen.value = true; });
</script>

<template>
  <div>
    <div class="photo-page-head">
      <div class="photo-page-title"><h2>照片</h2><span class="muted">筛选、搜索、排序可组合使用</span></div>
      <button class="button primary" @click="exportOpen = true">导出原图</button>
    </div>
    <PhotoManager :job-id="ctx.jobId" :filter="filter" @filter-change="setFilter" @selection-change="setSelection" />
    <ExportDialog :job-id="ctx.jobId" :selected-ids="selectedIds" :filter="filter" :open="exportOpen" @close="exportOpen = false" />
  </div>
</template>
