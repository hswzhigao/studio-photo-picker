<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import RetouchedFeedback from "./RetouchedFeedback.vue";
const props = defineProps({
  photos: Array,
  index: Number,
  base: String,
  admin: Boolean,
  identity: Number,
});
const emit = defineEmits(["close", "move", "changed"]);
const dialog = ref(null),
  versionId = ref(null),
  mode = ref("after"),
  zoom = ref(false),
  retryGeneration = ref(0);
let mediaGeneration = 0;
// Each render binds callbacks to its own request object. Detached img events
// can mutate only that retired object, never the newly selected media state.
const media = computed(() => {
  const generation = ++mediaGeneration;
  const attempt = retryGeneration.value;
  const current = photo.value;
  const viewMode = mode.value;
  return ["before", "after"]
    .filter((kind) => viewMode === "split" || viewMode === kind)
    .map((kind) => reactive({
      key: `${generation}-${kind}-${attempt}`,
      kind,
      src: kind === "before" ? current.before_url : current.original_url,
      loading: true,
      error: "",
    }));
});
const mediaError = computed(() => media.value.map((request) => request.error).filter(Boolean).join(" "));
function retryMedia() {
  retryGeneration.value++;
}
const asset = computed(() => props.photos[props.index]);
const versions = computed(() =>
  asset.value?.versions?.length ? asset.value.versions : [asset.value],
);
const photo = computed(
  () => versions.value.find((p) => p.id === versionId.value) || asset.value,
);
let previousFocus, previousOverflow;
function reset() {
  versionId.value = asset.value?.id;
  mode.value = "after";
  zoom.value = false;
}
watch(() => asset.value?.id, reset, { immediate: true });
watch(versionId, () => {
  mode.value = "after";
  zoom.value = false;
});
function keys(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "Tab") {
    const elements = [
      ...dialog.value.querySelectorAll(
        'button,a[href],area[href],input,textarea,select,summary,iframe,object,embed,audio[controls],video[controls],[contenteditable],[tabindex]',
      ),
    ].filter((el) => !el.matches(":disabled") && el.tabIndex >= 0 &&
      el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" &&
      !el.closest('[inert],[hidden]'));
    // Match the browser's positive-tabindex ordering before DOM-order tabindex=0.
    elements.sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
    const first = elements[0],
      last = elements.at(-1),
      active = document.activeElement;
    if (!elements.length) {
      event.preventDefault();
      dialog.value.focus();
    } else if (!elements.includes(active) ||
      (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (event.key === "ArrowLeft" && props.index > 0)
    emit("move", props.index - 1);
  if (event.key === "ArrowRight" && props.index < props.photos.length - 1)
    emit("move", props.index + 1);
}
onMounted(async () => {
  previousFocus = document.activeElement;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  await nextTick();
  dialog.value?.focus();
});
onUnmounted(() => {
  document.body.style.overflow = previousOverflow;
  previousFocus?.focus();
});
</script>
<template>
  <div class="rt-backdrop" @click.self="emit('close')">
    <section
      ref="dialog"
      class="rt-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="精修照片查看器"
      tabindex="-1"
      @keydown="keys"
    >
      <header class="rt-viewer-head">
        <div>
          <strong>{{ photo.filename }}</strong
          ><small>
            {{ index + 1 }} / {{ photos.length }} · V{{ photo.version }}</small
          >
        </div>
        <button
          class="button ghost"
          aria-label="关闭查看器"
          @click="emit('close')"
        >
          关闭 ×
        </button>
      </header>
      <div class="rt-viewer-body">
        <div class="rt-image-column">
          <div class="rt-actions">
            <button
              class="button ghost"
              :disabled="index === 0"
              @click="emit('move', index - 1)"
            >
              上一张</button
            ><button
              class="button ghost"
              :disabled="index === photos.length - 1"
              @click="emit('move', index + 1)"
            >
              下一张
            </button>
            <button class="button ghost" @click="zoom = !zoom">
              {{ zoom ? "适应窗口" : "放大原图" }}
            </button>
            <button
              class="button ghost"
              :disabled="!photo.before_url"
              @click="mode = mode === 'before' ? 'after' : 'before'"
            >
              {{ mode === "before" ? "查看修后" : "查看修前" }}
            </button>
            <button
              class="button ghost"
              :disabled="!photo.before_url"
              @click="mode = mode === 'split' ? 'after' : 'split'"
            >
              并排对比
            </button>
          </div>
          <p class="muted">
            {{
              photo.before_url
                ? "修前为低清、水印预览，仅供核对；修后为上传原文件。"
                : "未关联原片，暂不可对比修前照片。"
            }}
          </p>
          <div v-if="mediaError" class="alert danger" role="alert">
            {{ mediaError }}
            <button
              class="button ghost small"
              @click="retryMedia"
            >
              重试加载
            </button>
            <button v-if="photo.id !== asset.id" class="button ghost small" @click="versionId = asset.id">
              返回当前版本
            </button>
          </div>
          <div
            class="rt-stage"
            :class="{ 'rt-split': mode === 'split', 'rt-zoom': zoom }"
          >
            <figure v-for="request in media" :key="request.key" :aria-busy="request.loading">
              <figcaption>{{ request.kind === 'before' ? '修前 · 低清水印' : '精修 · 原文件' }}</figcaption>
              <p v-if="request.loading" role="status">{{ request.kind === 'before' ? '正在加载修前预览…' : '正在加载原文件…' }}</p>
              <img
                :src="request.src"
                :alt="request.kind === 'before' ? '修前低清水印预览' : photo.filename"
                @load="request.loading = false"
                @error="
                  request.loading = false;
                  request.error = request.kind === 'before'
                    ? '修前预览不可用，请重试或联系影楼。'
                    : '原文件加载失败，版本可能已撤回或文件不可用，请重试或刷新列表。';
                "
              />
            </figure>
          </div>
        </div>
        <aside class="rt-details">
          <label
            >版本历史<select v-model="versionId">
              <option v-for="v in versions" :key="v.id" :value="v.id">
                V{{ v.version }} ·
                {{
                  v.status === "published"
                    ? "已发布"
                    : v.status === "ready"
                      ? "草稿"
                      : "已撤回"
                }}{{ v.id === asset.id ? " · 列表当前版" : "" }}
              </option>
            </select></label
          >
          <a class="button primary" :href="photo.download_url" download
            >下载此版本原文件</a
          >
          <RetouchedFeedback
            :key="`${base}/${photo.id}`"
            :base="base"
            :photo="photo"
            :current="photo.id === asset.id"
            :admin="admin"
            :identity="identity"
            @changed="emit('changed')"
          />
        </aside>
      </div>
    </section>
  </div>
</template>
