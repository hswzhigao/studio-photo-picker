<script setup>
import { computed, onUnmounted, ref, watch } from "vue";
import { api } from "../api";
import { canEditFeedback, latestRequest } from "../utils/retouched";
const props = defineProps({
  base: String,
  photo: Object,
  current: Boolean,
  admin: Boolean,
  identity: Number,
});
const emit = defineEmits(["changed"]);
const comments = ref([]),
  loading = ref(false),
  error = ref(""),
  text = ref(""),
  visibility = ref("studio_only"),
  reply = ref(null),
  editing = ref(null),
  busy = ref(false);
const gate = latestRequest();
const endpoint = computed(() => `${props.base}/${props.photo.id}/comments`);
const editable = (c) =>
  canEditFeedback(c, props.admin ? "staff" : "customer", props.identity);
async function load() {
  const token = gate.next(),
    url = endpoint.value;
  loading.value = true;
  comments.value = [];
  error.value = "";
  try {
    const data = await api.get(url);
    if (gate.isCurrent(token)) comments.value = data.comments || [];
  } catch (e) {
    if (gate.isCurrent(token)) error.value = e.message || "反馈加载失败";
  } finally {
    if (gate.isCurrent(token)) loading.value = false;
  }
}
function startEdit(c) {
  editing.value = c.id;
  text.value = c.content;
  reply.value = null;
}
function cancel() {
  editing.value = null;
  reply.value = null;
  text.value = "";
  visibility.value = "studio_only";
}
async function save() {
  if (
    busy.value ||
    !text.value.trim() ||
    text.value.length > 500 ||
    (!editing.value && !props.admin && !props.current)
  )
    return;
  const url = endpoint.value,
    token = gate.next();
  busy.value = true;
  error.value = "";
  try {
    if (editing.value)
      await api.patch(`${url}/${editing.value}`, {
        content: text.value.trim(),
      });
    else
      await api.post(url, {
        content: text.value.trim(),
        visibility: visibility.value,
        ...(reply.value ? { parent_id: reply.value.id } : {}),
      });
    if (gate.isCurrent(token)) {
      cancel();
      await load();
      emit("changed");
    }
  } catch (e) {
    if (gate.isCurrent(token)) error.value = e.message || "反馈发送失败";
  } finally {
    busy.value = false;
  }
}
async function remove(c) {
  if (busy.value || !editable(c) || !window.confirm("删除这条反馈？")) return;
  const url = endpoint.value,
    token = gate.next();
  busy.value = true;
  try {
    await api.del(`${url}/${c.id}`);
    if (gate.isCurrent(token)) {
      await load();
      emit("changed");
    }
  } catch (e) {
    if (gate.isCurrent(token)) error.value = e.message || "删除失败";
  } finally {
    busy.value = false;
  }
}
watch(
  endpoint,
  () => {
    cancel();
    load();
  },
  { immediate: true },
);
onUnmounted(() => gate.next());
</script>
<template>
  <section class="rt-feedback" aria-label="精修反馈">
    <div class="section-head">
      <h3>精修反馈</h3>
      <button class="button ghost small" :disabled="busy" @click="load">
        刷新
      </button>
    </div>
    <p class="muted">反馈仅针对此版本；本人反馈可在 5 分钟内编辑或删除。按钮不会按时间自动刷新，是否超时以保存或删除时的服务端检查为准。</p>
    <div v-if="error" class="alert danger" role="alert">{{ error }}</div>
    <p v-if="loading" role="status">正在加载反馈…</p>
    <p v-else-if="!error && !comments.length" class="muted">还没有反馈。</p>
    <article
      v-for="c in comments"
      :key="c.id"
      class="rt-comment"
      :class="{ 'rt-reply': c.parent_id }"
    >
      <small
        >{{ c.author_name }} ·
        {{
          c.visibility === "studio_only" ? "仅本人和影楼可见" : "订单成员可见"
        }}
        · {{ c.created_at?.slice(0, 16).replace("T", " ") }}</small
      >
      <p>{{ c.content }}</p>
      <div class="rt-actions">
        <button
          v-if="!c.parent_id && (admin || current)"
          class="button ghost small"
          :disabled="busy"
          @click="
            cancel();
            reply = c;
          "
        >
          回复
        </button>
        <template v-if="editable(c)"
          ><button
            class="button ghost small"
            :disabled="busy"
            @click="startEdit(c)"
          >
            编辑</button
          ><button
            class="button ghost small"
            :disabled="busy"
            @click="remove(c)"
          >
            删除
          </button></template
        >
      </div>
    </article>
    <form v-if="admin || current || editing" @submit.prevent="save">
      <p v-if="reply || editing">
        {{ editing ? "编辑反馈" : `回复 ${reply.author_name}` }}
        <button type="button" class="button ghost small" @click="cancel">
          取消
        </button>
      </p>
      <label
        >反馈内容<textarea
          v-model="text"
          maxlength="500"
          rows="3"
          :disabled="busy"
          required
          placeholder="告诉影楼需要调整的细节…"
        ></textarea>
      </label>
      <label v-if="!reply && !editing"
        >可见范围<select v-model="visibility" :disabled="busy">
          <option value="studio_only">仅本人和影楼可见</option>
          <option value="all">本订单成员可见</option>
        </select></label
      >
      <p v-if="reply" class="muted">回复沿用原反馈的可见范围。</p>
      <button
        class="button primary"
        :disabled="busy || !text.trim() || loading"
      >
        {{ busy ? "保存中…" : editing ? "保存修改" : "发送反馈" }}
      </button>
    </form>
    <p v-else class="muted">这是历史版本，请切换当前版本后发送新反馈。</p>
  </section>
</template>
