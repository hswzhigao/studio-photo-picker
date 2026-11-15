<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
const props = defineProps({
  originals: { type: Array, default: () => [] },
  currentId: { type: Number, default: null },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(["select", "close"]);
const dialog = ref(null),
  query = ref(""),
  chosen = ref(props.currentId);
let previousFocus, previousOverflow;
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.originals;
  return props.originals.filter(
    (p) =>
      p.filename.toLowerCase().includes(needle) ||
      (p.display_name || "").toLowerCase().includes(needle) ||
      String(p.id).includes(needle),
  );
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
  }
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
      class="rt-picker"
      role="dialog"
      aria-modal="true"
      aria-label="关联修前原片"
      tabindex="-1"
      @keydown="keys"
    >
      <header class="rt-viewer-head">
        <div>
          <strong>关联修前原片</strong>
          <small>共 {{ originals.length }} 张可选，点选后确认</small>
        </div>
        <button
          class="button ghost"
          aria-label="关闭选择器"
          :disabled="busy"
          @click="emit('close')"
        >
          关闭 ×
        </button>
      </header>
      <div class="rt-picker-body">
        <label
          >按文件名或编号过滤<input
            :value="query"
            type="search"
            placeholder="例如：IMG_1234 或 42"
            :disabled="busy"
            aria-label="过滤修前原片"
            @input="query = $event.target.value"
        /></label>
        <p v-if="!originals.length" class="muted">
          没有可选的原片，请确认原片已导入或刷新页面。
        </p>
        <p v-else-if="!filtered.length" class="muted">没有匹配的原片。</p>
        <ul v-else class="rt-picker-grid">
          <li v-for="p in filtered" :key="p.id">
            <button
              type="button"
              class="rt-picker-item"
              :class="{
                'rt-picker-item-chosen': chosen === p.id,
                'rt-picker-item-current': p.id === currentId,
              }"
              :disabled="busy"
              :aria-pressed="chosen === p.id"
              @click="chosen = p.id"
            >
              <img
                :src="p.thumb_url"
                :alt="p.display_name || p.filename"
                loading="lazy"
              />
              <span>#{{ p.id }}</span>
              <small>{{ p.display_name || p.filename }}</small>
              <em v-if="p.id === currentId">当前关联</em>
            </button>
          </li>
        </ul>
      </div>
      <footer class="rt-picker-foot">
        <button
          class="button ghost"
          :disabled="busy"
          @click="emit('select', null)"
        >
          暂不关联
        </button>
        <span class="rt-actions">
          <button
            class="button primary"
            :disabled="busy || chosen === null"
            @click="emit('select', chosen)"
          >
            确认关联
          </button>
          <button class="button ghost" :disabled="busy" @click="emit('close')">
            取消
          </button>
        </span>
      </footer>
    </section>
  </div>
</template>
