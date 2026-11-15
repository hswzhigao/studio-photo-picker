<script setup>
import { computed, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "../../api";
import { latestRequest } from "../../utils/retouched";
import RetouchedViewer from "../../components/RetouchedViewer.vue";
import "../../retouched.css";
const route = useRoute();
const base = computed(() => `/api/client/jobs/${route.params.id}/retouched`);
const photos = ref([]),
  loading = ref(true),
  error = ref(""),
  wechat = ref(false),
  index = ref(null),
  selectorId = ref(null);
const gate = latestRequest();
async function load(initial = false) {
  const token = gate.next(),
    url = base.value;
  if (initial) loading.value = true;
  error.value = "";
  try {
    const [data, job] = await Promise.all([
      api.get(url),
      api.get(`/api/client/jobs/${route.params.id}`),
    ]);
    if (!gate.isCurrent(token)) return;
    const opened = photos.value[index.value]?.asset_id;
    photos.value = data.photos || [];
    wechat.value = Boolean(data.wechat);
    selectorId.value = job.me?.id ?? null;
    if (index.value !== null) {
      const found = photos.value.findIndex((p) => p.asset_id === opened);
      index.value = found < 0 ? null : found;
    }
  } catch (e) {
    if (gate.isCurrent(token)) {
      error.value = e.message || "精修照片加载失败";
      index.value = null;
    }
  } finally {
    if (gate.isCurrent(token)) loading.value = false;
  }
}
watch(
  base,
  () => {
    index.value = null;
    photos.value = [];
    selectorId.value = null;
    load(true);
  },
  { immediate: true },
);
onUnmounted(() => gate.next());
</script>
<template>
  <main class="rt-page rt-client">
    <header class="rt-heading">
      <div>
        <p class="eyebrow">YOUR FINISHED PHOTOGRAPHS</p>
        <h1>精修后的照片</h1>
        <p class="muted">细看每一处心动，留存完整画质。</p>
      </div>
      <div class="rt-actions">
        <button class="button ghost" :disabled="loading" @click="load()">
          刷新</button
        ><a
          v-if="photos.length"
          class="button primary"
          :href="`${base}/download-all`"
          download
          >下载全部原文件（ZIP）</a
        >
      </div>
    </header>
    <p v-if="wechat" class="alert">
      微信内可能无法保存原文件。请点击右上角，选择在浏览器中打开后下载。
    </p>
    <div v-if="error" class="alert danger" role="alert">
      {{ error }}
      <button class="button ghost small" @click="load(true)">重试</button>
    </div>
    <p v-if="loading" class="loading" role="status">正在加载精修照片…</p>
    <div v-else-if="!photos.length && !error" class="empty-state">
      精修照片尚未发布，影楼交付后将在这里呈现。
    </div>
    <div v-else class="rt-grid">
      <article
        v-for="(photo, i) in photos"
        :key="photo.asset_id"
        class="rt-photo"
      >
        <button
          class="rt-thumbnail"
          :aria-label="`查看 ${photo.filename}`"
          @click="index = i"
        >
          <img
            :src="photo.thumb_url"
            :alt="photo.filename"
            loading="lazy"
            @error="error = '部分缩略图加载失败，照片可能已撤回，请刷新。'"
          /><span>查看原文件</span>
        </button>
        <div class="rt-photo-caption">
          <strong>{{ photo.filename }}</strong
          ><small
            >V{{ photo.version }} · {{ photo.comment_count || 0 }} 条反馈</small
          ><a :href="photo.download_url" download>下载原文件</a>
        </div>
      </article>
    </div>
    <RetouchedViewer
      v-if="index !== null && photos[index]"
      :photos="photos"
      :index="index"
      :base="base"
      :identity="selectorId"
      @move="index = $event"
      @close="index = null"
      @changed="load()"
    />
  </main>
</template>
