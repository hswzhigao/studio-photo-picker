<script setup>
import { computed, inject, onUnmounted, ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from "vue-router";
import { api } from "../../api";
import {
  batchIds,
  duplicateNames,
  latestRequest,
  runUploadQueue,
  uploadUrl,
} from "../../utils/retouched";
import RetouchedViewer from "../../components/RetouchedViewer.vue";
import "../../retouched.css";
const route = useRoute(),
  admin = inject("admin", { actor: null });
const base = computed(() => `/api/admin/jobs/${route.params.id}/retouched`);
const photos = ref([]),
  originals = ref([]),
  loading = ref(true),
  error = ref(""),
  selected = ref([]),
  index = ref(null),
  queue = ref([]),
  uploading = ref(false),
  busy = ref(false),
  targetAsset = ref(""),
  pairId = ref("");
const gate = latestRequest();
let alive = true,
  contextToken = 0;
const pendingPair = ref(null);
const allVersions = computed(() =>
  photos.value.flatMap((p) => (p.versions?.length ? p.versions : [p])),
);
const pair = computed(() =>
  originals.value.find((p) => p.id === Number(pairId.value)),
);
const hasUploads = computed(() =>
  queue.value.some((r) => ["queued", "uploading"].includes(r.status)),
);
function label(status) {
  return (
    { ready: "草稿", published: "已发布", withdrawn: "已撤回" }[status] ||
    status
  );
}
async function load(initial = false) {
  const token = gate.next(),
    url = base.value;
  if (initial) loading.value = true;
  try {
    const data = await api.get(url);
    if (!gate.isCurrent(token)) return;
    error.value = "";
    const opened = photos.value[index.value]?.asset_id;
    photos.value = data.photos || [];
    selected.value = selected.value.filter((id) =>
      allVersions.value.some((v) => v.id === id),
    );
    if (index.value !== null) {
      const found = photos.value.findIndex((p) => p.asset_id === opened);
      index.value = found < 0 ? null : found;
    }
  } catch (e) {
    if (gate.isCurrent(token)) error.value = e.message || "精修交付加载失败";
  } finally {
    if (gate.isCurrent(token)) loading.value = false;
  }
}
async function loadOriginals() {
  const url = `/api/admin/jobs/${route.params.id}/photos`;
  const token = contextToken;
  let page = 1,
    list = [];
  try {
    while (true) {
      const data = await api.get(`${url}?page_size=200&page=${page}`);
      if (token !== contextToken || !alive) return;
      list.push(...(data.photos || []));
      if (!data.pagination?.has_more) break;
      page++;
    }
    originals.value = list.filter((p) =>
      p.import_status === "ready" && !p.hidden && !p.deleted_at,
    );
  } catch (e) {
    if (token === contextToken && alive)
      error.value = e.message || "原片列表加载失败，无法关联";
  }
}
async function chooseFiles(event) {
  const files = [...event.target.files];
  event.target.value = "";
  if (uploading.value || busy.value || !files.length) return;
  error.value = "";
  if (files.length > 100) {
    error.value = "每批最多上传 100 张，请分批选择。";
    return;
  }
  if (files.some((f) => !["image/jpeg", "image/png"].includes(f.type))) {
    error.value = "仅支持 JPEG / PNG，请重新选择。";
    return;
  }
  if (targetAsset.value && files.length !== 1) {
    error.value = "上传新版一次只能选择一张照片。";
    return;
  }
  const duplicates = duplicateNames(files, allVersions.value);
  if (
    !targetAsset.value &&
    duplicates.length &&
    !window.confirm(
      `发现同名文件：${duplicates.join("、")}。\n作为独立新照片上传？若这是修订，请取消后选择“上传新版”。`,
    )
  )
    return;
  const url = uploadUrl(
    base.value,
    targetAsset.value,
    Number(pairId.value) || null,
  );
  queue.value = files.map((file, i) => ({
    id: i,
    file,
    url,
    name: file.name,
    status: "queued",
    progress: 0,
    error: "",
  }));
  await processQueue();
}
async function processQueue() {
  if (uploading.value) return;
  uploading.value = true;
  const token = contextToken;
  await runUploadQueue(
    queue.value,
    (row) =>
      api.upload(row.url, row.file, {
        onProgress: (p) => {
          row.progress = p;
        },
      }),
    () => alive && contextToken === token,
  );
  uploading.value = false;
  if (alive && contextToken === token) await load();
}
function retry(row) {
  if (uploading.value) return;
  row.status = "queued";
  row.progress = 0;
  processQueue();
}
function versionUpload(photo) {
  targetAsset.value = photo.asset_id;
  pairId.value = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function associate(photo, event) {
  if (busy.value || uploading.value) return;
  const photoId = Number(event.target.value) || null;
  pendingPair.value = {
    photo,
    photoId,
    original: originals.value.find((p) => p.id === photoId),
  };
  event.target.value = photo.photo_id || "";
}
async function confirmPair() {
  if (busy.value || !pendingPair.value) return;
  const { photo, photoId } = pendingPair.value;
  const url = base.value;
  busy.value = true;
  error.value = "";
  try {
    await api.patch(`${url}/${photo.id}`, { photo_id: photoId });
    if (base.value === url) {
      pendingPair.value = null;
      await load();
    }
  } catch (e) {
    if (base.value === url) error.value = e.message || "关联失败";
  } finally {
    busy.value = false;
  }
}
async function batch(action) {
  const ids = batchIds(allVersions.value, selected.value, action);
  if (!ids.length || busy.value || uploading.value) return;
  if (ids.length > 100) {
    error.value = "每次最多操作 100 个版本。";
    return;
  }
  if (
    !window.confirm(
      `确认${action === "publish" ? "发布" : "撤回"} ${ids.length} 个精修版本？${action === "withdraw" ? "客户将无法访问被撤回版本，列表可能回退历史已发布版。" : "客户将可查看和下载这些原文件。"}`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  const url = base.value;
  try {
    await api.post(`${url}/${action}`, { ids });
    if (base.value === url) {
      selected.value = [];
      await load();
    }
  } catch (e) {
    if (base.value === url) error.value = e.message || "操作失败";
  } finally {
    busy.value = false;
  }
}
watch(
  base,
  () => {
    contextToken++;
    gate.next();
    pendingPair.value = null;
    photos.value = [];
    originals.value = [];
    selected.value = [];
    index.value = null;
    targetAsset.value = "";
    pairId.value = "";
    queue.value = [];
    error.value = "";
    load(true);
    loadOriginals();
  },
  { immediate: true },
);
const allowNavigation = () =>
  !uploading.value ||
  window.confirm(
    "上传尚未完成。离开后正在进行的最多两张仍可能完成，其余等待文件将停止。确定离开？",
  );
onBeforeRouteLeave(allowNavigation);
onBeforeRouteUpdate(allowNavigation);
onUnmounted(() => {
  alive = false;
  gate.next();
});
</script>
<template>
  <section class="rt-page rt-admin">
    <header class="rt-heading">
      <div>
        <p class="eyebrow">RETOUCHED DELIVERY</p>
        <h2>精修交付</h2>
        <p class="muted">
          原文件交付，与原片选片状态相互独立。草稿仅影楼可见。
        </p>
      </div>
      <button
        class="button ghost"
        :disabled="loading || busy"
        @click="
          error = '';
          load();
        "
      >
        刷新
      </button>
    </header>
    <div v-if="error" class="alert danger" role="alert">{{ error }}</div>
    <section class="rt-upload">
      <h3>上传精修照片</h3>
      <div class="rt-upload-options">
        <label
          >交付方式<select v-model="targetAsset" :disabled="uploading">
            <option value="">新增独立照片</option>
            <option v-for="p in photos" :key="p.asset_id" :value="p.asset_id">
              上传新版 · {{ p.filename }}
            </option>
          </select></label
        >
        <label v-if="!targetAsset"
          >关联修前原片（可选）<select v-model="pairId" :disabled="uploading">
            <option value="">暂不关联</option>
            <option v-for="p in originals" :key="p.id" :value="p.id">
              #{{ p.id }} · {{ p.display_name || p.filename }}
            </option>
          </select></label
        >
      </div>
      <img
        v-if="pair"
        class="rt-pair-thumb"
        :src="pair.thumb_url"
        alt="待关联修前原片，请核对"
      />
      <p class="muted">
        {{
          targetAsset
            ? "新版继承原照片关联；一次选择一张。发布前仍为草稿。"
            : "JPEG / PNG，每批最多 100 张，最多 2 张同时上传。同名照片不会自动合并为新版。"
        }}
      </p>
      <label class="rt-file-label"
        >选择{{ targetAsset ? "新版文件" : "精修文件"
        }}<input
          type="file"
          accept="image/jpeg,image/png"
          :multiple="!targetAsset"
          :disabled="uploading || busy"
          @change="chooseFiles"
      /></label>
      <ol v-if="queue.length" class="rt-upload-list">
        <li v-for="row in queue" :key="row.id">
          <strong>{{ row.name }}</strong
          ><progress
            :value="row.progress"
            max="100"
            :aria-label="`${row.name} 上传进度`"
          ></progress
          ><span
            >{{
              {
                queued: "等待上传",
                uploading: "上传 / 处理原文件中",
                done: "草稿已就绪",
                failed: "失败",
              }[row.status]
            }}
            {{ row.progress }}%</span
          ><span v-if="row.error" class="danger-text" role="alert">{{
            row.error
          }}</span
          ><button
            v-if="row.status === 'failed'"
            class="button ghost small"
            :disabled="uploading"
            @click="retry(row)"
          >
            单张重试
          </button>
        </li>
      </ol>
      <p v-if="hasUploads" role="status">
        请等待本批上传完成后切换订单；上传成功不会自动发布。
      </p>
    </section>
    <section
      v-if="pendingPair"
      class="rt-pair-review"
      aria-label="关联原片核对"
    >
      <h3>核对修前 / 修后</h3>
      <div class="rt-pair">
        <img :src="pendingPair.photo.thumb_url" alt="待关联的修后照片" /><img
          v-if="pendingPair.original"
          :src="pendingPair.original.thumb_url"
          alt="待关联的修前原片"
        />
        <p>
          {{ pendingPair.photo.filename }} →
          {{
            pendingPair.original?.display_name ||
            pendingPair.original?.filename ||
            "不关联原片"
          }}
        </p>
      </div>
      <div class="rt-actions">
        <button class="button primary" :disabled="busy" @click="confirmPair">
          确认关联</button
        ><button
          class="button ghost"
          :disabled="busy"
          @click="pendingPair = null"
        >
          取消
        </button>
      </div>
    </section>
    <div class="rt-batch">
      <span>已勾选 {{ selected.length }} 个版本</span
      ><button
        class="button primary"
        :disabled="
          busy ||
          uploading ||
          !batchIds(allVersions, selected, 'publish').length
        "
        @click="batch('publish')"
      >
        发布选中草稿（{{
          batchIds(allVersions, selected, "publish").length
        }}）</button
      ><button
        class="button ghost"
        :disabled="
          busy ||
          uploading ||
          !batchIds(allVersions, selected, 'withdraw').length
        "
        @click="batch('withdraw')"
      >
        撤回选中已发布版（{{
          batchIds(allVersions, selected, "withdraw").length
        }}）
      </button>
    </div>
    <p v-if="loading" role="status">正在加载精修照片…</p>
    <p v-else-if="!photos.length && !error" class="empty-state">
      还没有精修照片，请先上传原文件。
    </p>
    <div class="rt-grid">
      <article
        v-for="(photo, i) in photos"
        :key="photo.asset_id"
        class="rt-photo"
      >
        <button
          class="rt-thumbnail"
          :aria-label="`查看 ${photo.filename} 的版本与反馈`"
          @click="index = i"
        >
          <img
            :src="photo.thumb_url"
            :alt="photo.filename"
            loading="lazy"
            @error="error = '部分精修缩略图不可用，请刷新或重新上传新版。'"
          /><span>查看版本与反馈</span>
        </button>
        <div class="rt-photo-caption">
          <strong>{{ photo.filename }}</strong
          ><small
            >当前列表 V{{ photo.version }} · {{ label(photo.status) }}</small
          ><button
            class="button ghost small"
            :disabled="uploading"
            @click="versionUpload(photo)"
          >
            上传新版
          </button>
          <label
            >关联原片<select
              :value="photo.photo_id || ''"
              :disabled="
                busy ||
                uploading ||
                photo.versions?.some((v) => v.status === 'published')
              "
              @change="associate(photo, $event)"
            >
              <option value="">未关联</option>
              <option v-for="p in originals" :key="p.id" :value="p.id">
                #{{ p.id }} · {{ p.display_name || p.filename }}
              </option>
            </select></label
          >
          <div v-if="photo.photo_id" class="rt-pair">
            <img
              :src="originals.find((p) => p.id === photo.photo_id)?.thumb_url"
              alt="已关联修前原片"
              loading="lazy"
            /><small>修前核对 · #{{ photo.photo_id }}</small>
          </div>
          <fieldset class="rt-versions">
            <legend>版本 / 发布状态</legend>
            <label v-for="v in photo.versions || [photo]" :key="v.id"
              ><input
                v-model="selected"
                type="checkbox"
                :value="v.id"
                :disabled="busy || uploading || v.status === 'withdrawn'"
              />
              V{{ v.version }} · {{ label(v.status) }} ·
              {{ v.comment_count || 0 }} 条反馈</label
            >
          </fieldset>
        </div>
      </article>
    </div>
    <RetouchedViewer
      v-if="index !== null && photos[index]"
      :photos="photos"
      :index="index"
      :base="base"
      admin
      :identity="admin.actor?.actor_id"
      @move="index = $event"
      @close="index = null"
      @changed="load()"
    />
  </section>
</template>
