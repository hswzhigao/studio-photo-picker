<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api } from '../api';

const props = defineProps({ jobId: { type: Number, required: true } });

const photos = ref([]);
const counts = ref({ total: 0, hidden: 0, processing: 0, failed: 0, trash: 0 });
const queue = ref({ processing: 0, failed: 0, ready: 0, total: 0 });
const jobStatus = ref('');
const loading = ref(false);
const error = ref('');
const trash = ref(false);
const selected = ref([]);
const sortBy = ref('');
const lightbox = ref(null);
const dragId = ref(0);

const uploadItems = ref([]);
const allowDuplicate = ref(false);
const pumping = ref(false);
const uploadSequence = ref(0);

const sourceInfo = ref({ root: '', directories: [], root_image_count: 0 });
const sourceDir = ref('');
const importTask = ref(null);

const photoInput = ref(null);
const folderInput = ref(null);
const replaceInput = ref(null);
const replaceTarget = ref(0);

let queueTimer = null;
let importTimer = null;

const doneCount = computed(() => uploadItems.value.filter(item => ['done', 'duplicate'].includes(item.status)).length);
const uploadPercent = computed(() => uploadItems.value.length ? Math.round(uploadItems.value.reduce((sum, item) => sum + (item.status === 'done' ? 100 : item.progress || 0), 0) / uploadItems.value.length) : 0);
const allSelected = computed(() => photos.value.length > 0 && selected.value.length === photos.value.length);
const uploadBusy = computed(() => uploadItems.value.some(item => ['queued', 'uploading'].includes(item.status)));

function statusLabel(photo) {
  if (photo.import_status === 'processing') return '处理中…';
  if (photo.import_status === 'failed') return '处理失败';
  if (photo.import_status === 'pending') return '排队中…';
  return '';
}

async function refresh() {
  if (!props.jobId) return;
  loading.value = true;
  try {
    const data = await api.get(`/api/admin/jobs/${props.jobId}/photos?trash=${trash.value ? 1 : 0}`);
    photos.value = data.photos || [];
    counts.value = data.counts || counts.value;
    jobStatus.value = data.job_status || jobStatus.value;
    selected.value = selected.value.filter(id => photos.value.some(photo => photo.id === id));
    error.value = '';
  } catch (e) { error.value = e.message || '照片加载失败'; }
  finally { loading.value = false; }
}

async function refreshQueue() {
  if (!props.jobId) return;
  try {
    const data = await api.get(`/api/admin/jobs/${props.jobId}/photo-queue`);
    queue.value = data.queue || queue.value;
    counts.value.processing = queue.value.processing;
    if (queue.value.processing > 0) {
      clearTimeout(queueTimer);
      queueTimer = setTimeout(async () => { await refreshQueue(); await refresh(); }, 900);
    } else if (uploadItems.value.length) await refresh();
  } catch {}
}

async function loadSourceInfo() {
  try {
    const data = await api.get('/api/admin/source-dirs');
    sourceInfo.value = data;
    if (!sourceDir.value && data.directories?.length) sourceDir.value = data.directories[0].name;
  } catch (e) { error.value = e.message || '服务器文件夹读取失败'; }
}

function toggleSelect(id) {
  selected.value = selected.value.includes(id) ? selected.value.filter(item => item !== id) : [...selected.value, id];
}

function toggleSelectAll() { selected.value = allSelected.value ? [] : photos.value.map(photo => photo.id); }

async function toggleTrash() {
  trash.value = !trash.value;
  selected.value = [];
  await refresh();
}

async function renamePhoto(photo) {
  const name = window.prompt('修改显示名称（客户看到的名字）', photo.display_name || photo.filename);
  if (name === null) return;
  try { await api.patch(`/api/admin/jobs/${props.jobId}/photos/${photo.id}`, { display_name: name }); await refresh(); }
  catch (e) { error.value = e.message; }
}

async function toggleHidden(photo) {
  try { await api.patch(`/api/admin/jobs/${props.jobId}/photos/${photo.id}`, { hidden: !photo.hidden }); await refresh(); }
  catch (e) { error.value = e.message; }
}

function confirmText(impact) {
  if (!impact) return '';
  const parts = [];
  const list = Array.isArray(impact) ? impact : [impact];
  for (const item of list) {
    if (item.selectors?.length) parts.push(`${item.selectors.map(s => s.name).join('、')} 选了这张`);
    if (item.comment_count) parts.push(`${item.comment_count} 条评论`);
    if (item.slot_items?.length) parts.push(`被指定为 ${item.slot_items.map(x => x.name).join('、')}`);
  }
  return parts.join('；');
}

async function runDelete(request) {
  try { await request({ confirm: false }); }
  catch (e) {
    if (e.code !== 'CONFIRM_REQUIRED') throw e;
    const message = `这张/这些照片已有选择或评论：${e.message || confirmText(e.impact)}。\n删除后相关选择不再计入额度，相框/摆台会变为未指定，客户会收到通知。\n确定移入回收站吗？`;
    if (!window.confirm(message)) return false;
    await request({ confirm: true });
  }
  await refresh();
  return true;
}

async function deletePhoto(photo) {
  try { await runDelete(body => api.del(`/api/admin/jobs/${props.jobId}/photos/${photo.id}`, body)); }
  catch (e) { error.value = e.message; }
}

async function restorePhoto(photo) {
  try { await api.post(`/api/admin/jobs/${props.jobId}/photos/${photo.id}/restore`); await refresh(); }
  catch (e) { error.value = e.message; }
}

async function batch(action) {
  if (!selected.value.length) return;
  try {
    const ids = [...selected.value];
    if (action === 'delete') {
      const ok = await runDelete(async body => api.post(`/api/admin/jobs/${props.jobId}/photos/batch`, { action, ids, ...body }));
      if (ok) selected.value = [];
    } else {
      await api.post(`/api/admin/jobs/${props.jobId}/photos/batch`, { action, ids });
      selected.value = [];
      await refresh();
    }
  } catch (e) { error.value = e.message; }
}

async function onSort() {
  if (!sortBy.value) return;
  try { await api.post(`/api/admin/jobs/${props.jobId}/photos/reorder`, { by: sortBy.value }); sortBy.value = ''; await refresh(); }
  catch (e) { error.value = e.message; }
}

function onDragStart(photo) { dragId.value = photo.id; }
async function onDropPhoto(target) {
  if (!dragId.value || dragId.value === target.id) return;
  const ids = photos.value.map(photo => photo.id);
  const from = ids.indexOf(dragId.value);
  const to = ids.indexOf(target.id);
  ids.splice(from, 1);
  ids.splice(to, 0, dragId.value);
  dragId.value = 0;
  try { await api.post(`/api/admin/jobs/${props.jobId}/photos/reorder`, { ids }); await refresh(); }
  catch (e) { error.value = e.message; }
}

function pickPhotos() { photoInput.value?.click(); }
function pickFolder() { folderInput.value?.click(); }

async function readEntry(entry) {
  if (entry.isFile) return new Promise((resolve, reject) => entry.file(resolve, reject));
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    entries.push(...batch);
  }
  const files = [];
  for (const child of entries) files.push(...await readEntry(child));
  return files;
}

function isImageFile(file) { return /\.(jpe?g|png|heic|heif)$/i.test(file.name || ''); }

function enqueueFiles(files, { replaceId = 0 } = {}) {
  const list = [...files].filter(isImageFile);
  if (!list.length) { error.value = '请选择 jpg / jpeg / png / heic 图片'; return; }
  for (const file of list) {
    uploadItems.value.push({
      uid: ++uploadSequence.value,
      file,
      name: file.name,
      status: 'queued',
      progress: 0,
      error: '',
      forceDuplicate: false,
      kind: replaceId ? 'replace' : 'upload',
      replaceId,
      jobId: props.jobId,
    });
  }
  pumpUploads();
}

function onFilesPicked(event) {
  enqueueFiles([...(event.target.files || [])]);
  event.target.value = '';
}

function onFolderPicked(event) {
  enqueueFiles([...(event.target.files || [])]);
  event.target.value = '';
}

function replacePhoto(photo) {
  replaceTarget.value = photo.id;
  replaceInput.value?.click();
}

function onReplacePicked(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !replaceTarget.value) return;
  enqueueFiles([file], { replaceId: replaceTarget.value });
  replaceTarget.value = 0;
}

async function onDrop(event) {
  try {
    const items = [...(event.dataTransfer?.items || [])];
    let files = [];
    if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
      for (const item of items) {
        const entry = item.webkitGetAsEntry();
        if (entry) files.push(...await readEntry(entry));
      }
    }
    if (!files.length) files = [...(event.dataTransfer?.files || [])];
    enqueueFiles(files);
  } catch { error.value = '读取拖入文件失败，请用「选择照片」重试'; }
}

async function pumpUploads() {
  if (pumping.value || !props.jobId) return;
  pumping.value = true;
  const worker = async () => {
    while (true) {
      const item = uploadItems.value.find(candidate => candidate.status === 'queued');
      if (!item) return;
      item.status = 'uploading';
      item.progress = 0;
      item.error = '';
      try {
        const duplicate = allowDuplicate.value || item.forceDuplicate;
        const path = item.kind === 'replace'
          ? `/api/admin/jobs/${item.jobId}/photos/${item.replaceId}/file`
          : `/api/admin/jobs/${item.jobId}/photos${duplicate ? '?allow_duplicate=1' : ''}`;
        await api.upload(path, item.file, { method: item.kind === 'replace' ? 'PUT' : 'POST', onProgress: value => { item.progress = value; } });
        item.status = 'done';
        item.progress = 100;
      } catch (e) {
        if (e.code === 'DUPLICATE_PHOTO') {
          item.status = 'duplicate';
          item.error = '重复，已跳过';
          item.existingId = e.photo_id;
        } else {
          item.status = 'failed';
          item.error = e.code === 'UPLOAD_TOO_LARGE' ? '文件超过 50MB' : (e.message || '上传失败');
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  pumping.value = false;
  await refresh();
  await refreshQueue();
}

function retryUpload(item, forceDuplicate = false) {
  item.status = 'queued';
  item.forceDuplicate = forceDuplicate;
  item.error = '';
  item.progress = 0;
  pumpUploads();
}

function clearDone() { uploadItems.value = uploadItems.value.filter(item => !['done', 'duplicate'].includes(item.status)); }

async function importFolder() {
  if (!sourceDir.value) { error.value = '请选择服务器上的文件夹'; return; }
  try {
    const data = await api.post(`/api/admin/jobs/${props.jobId}/imports`, { source: sourceDir.value });
    importTask.value = data.import_task;
    pollImport();
  } catch (e) { error.value = e.message; }
}

async function pollImport() {
  if (!importTask.value) return;
  try {
    const data = await api.get(`/api/admin/jobs/${props.jobId}/imports/${importTask.value.id}`);
    importTask.value = data.import_task;
    if (['pending', 'processing'].includes(importTask.value.status)) importTimer = setTimeout(pollImport, 1000);
    else { await refresh(); await refreshQueue(); }
  } catch (e) { error.value = e.message; }
}

function openLightbox(photo) { lightbox.value = photo; }

function beforeUnload(event) {
  if (!uploadBusy.value) return;
  event.preventDefault();
  event.returnValue = '照片仍在上传，关闭页面会中断未完成的上传。';
}

async function resetAndLoad() {
  photos.value = []; counts.value = { total: 0, hidden: 0, processing: 0, failed: 0, trash: 0 };
  selected.value = []; trash.value = false; importTask.value = null; lightbox.value = null;
  await Promise.all([refresh(), refreshQueue(), loadSourceInfo()]);
}

watch(() => props.jobId, () => { resetAndLoad(); });
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); resetAndLoad(); });
onUnmounted(() => { window.removeEventListener('beforeunload', beforeUnload); clearTimeout(queueTimer); clearTimeout(importTimer); });
</script>

<template>
  <div class="photo-manager">
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div v-if="['locked', 'retouching', 'delivered'].includes(jobStatus)" class="alert">客户已提交，新照片需先在订单页「退回修改」后客户才能选。</div>

    <header class="photo-toolbar">
      <div class="photo-stats">
        <b>照片 {{ counts.total }} 张</b>
        <span>隐藏 {{ counts.hidden }}</span>
        <span v-if="counts.processing">处理中 {{ counts.processing }}</span>
        <span v-if="counts.failed" class="danger-text">失败 {{ counts.failed }}</span>
      </div>
      <div class="actions">
        <button class="button primary" type="button" @click="pickPhotos">上传照片</button>
        <button class="button ghost" type="button" @click="pickFolder">选择文件夹</button>
      </div>
    </header>

    <details class="photo-help">
      <summary>从服务器文件夹导入（批量）</summary>
      <p>这里列的是<strong>服务器</strong>上的文件夹。电脑上的照片请用上方「上传照片」。大批量时可先 rsync 到服务器：</p>
      <code>rsync -av --progress ./照片/ user@124.220.169.36:/srv/studio-photo-picker/photos/</code>
      <p class="muted">服务器目录：{{ sourceInfo.root || '未配置' }}</p>
    </details>

    <div class="dropzone" @dragover.prevent @drop.prevent="onDrop" @click="pickPhotos">
      <strong>拖拽照片或文件夹到这里</strong>
      <span>或点击选择照片 · 支持 jpg / jpeg / png / heic · 单张不超过 50MB</span>
    </div>

    <div class="source-import">
      <select v-model="sourceDir" aria-label="服务器文件夹">
        <option value="">选择服务器文件夹</option>
        <option v-for="dir in sourceInfo.directories" :key="dir.name" :value="dir.name">{{ dir.name }}（{{ dir.image_count }} 张）</option>
      </select>
      <button class="button ghost" type="button" :disabled="!sourceDir" @click="importFolder">导入所选文件夹</button>
      <span v-if="sourceInfo.root_image_count" class="muted">根目录另有 {{ sourceInfo.root_image_count }} 张可直接上传</span>
    </div>
    <p v-if="importTask" class="import-progress">
      导入 {{ importTask.status }}：{{ importTask.processed || 0 }} / {{ importTask.total || 0 }}
      <span v-if="importTask.failed">，失败 {{ importTask.failed }}</span>
      <span v-if="importTask.skipped">，重复跳过 {{ importTask.skipped }}</span>
    </p>

    <section v-if="uploadItems.length" class="upload-panel">
      <div class="upload-summary">
        <b>已完成 {{ doneCount }} / {{ uploadItems.length }}</b>
        <span class="progress-line"><i :style="{ width: uploadPercent + '%' }"></i></span>
        <label class="inline-check"><input v-model="allowDuplicate" type="checkbox" /> 仍然上传重复照片</label>
        <button class="button ghost small" type="button" @click="clearDone">清除已完成</button>
      </div>
      <ul class="upload-list">
        <li v-for="item in uploadItems" :key="item.uid" :class="item.status">
          <span class="upload-name" :title="item.name">{{ item.name }}</span>
          <span class="upload-state">
            <template v-if="item.status === 'queued'">排队中</template>
            <template v-else-if="item.status === 'uploading'">上传中 {{ item.progress }}%</template>
            <template v-else-if="item.status === 'done'">完成</template>
            <template v-else-if="item.status === 'duplicate'">重复，已跳过</template>
            <template v-else>失败：{{ item.error }}</template>
          </span>
          <span class="upload-bar"><i :style="{ width: (item.status === 'done' ? 100 : item.progress || 0) + '%' }"></i></span>
          <button v-if="item.status === 'failed'" class="button ghost small" type="button" @click="retryUpload(item)">重试</button>
          <button v-else-if="item.status === 'duplicate'" class="button ghost small" type="button" @click="retryUpload(item, true)">仍然上传</button>
        </li>
      </ul>
    </section>

    <div class="photo-toolbar secondary">
      <div class="actions">
        <button class="button ghost small" type="button" @click="toggleSelectAll">{{ allSelected ? '取消全选' : '全选' }}</button>
        <span class="muted">已选 {{ selected.length }} 张</span>
        <template v-if="!trash">
          <button class="button ghost small" type="button" :disabled="!selected.length" @click="batch('hide')">隐藏</button>
          <button class="button ghost small" type="button" :disabled="!selected.length" @click="batch('show')">显示</button>
          <button class="button danger small" type="button" :disabled="!selected.length" @click="batch('delete')">删除</button>
        </template>
        <button v-else class="button ghost small" type="button" :disabled="!selected.length" @click="batch('restore')">恢复</button>
      </div>
      <div class="actions">
        <select v-if="!trash" v-model="sortBy" aria-label="排序" @change="onSort">
          <option value="">排序…</option>
          <option value="filename">按文件名</option>
          <option value="taken_at">按拍摄时间</option>
          <option value="uploaded_at">按上传时间</option>
        </select>
        <button class="button ghost small" :class="{ on: trash }" type="button" @click="toggleTrash">回收站（{{ counts.trash }}）</button>
      </div>
    </div>

    <div v-if="loading" class="loading">正在加载照片…</div>
    <div v-else-if="!photos.length" class="empty-state">{{ trash ? '回收站是空的' : '还没有照片，把照片拖进来或点击「上传照片」' }}</div>
    <div v-else class="admin-photo-grid">
      <article
        v-for="photo in photos"
        :key="photo.id"
        class="admin-photo-card"
        :class="{ selected: selected.includes(photo.id), hidden: photo.hidden, processing: photo.import_status !== 'ready' }"
        draggable="true"
        @dragstart="onDragStart(photo)"
        @dragover.prevent
        @drop.stop="onDropPhoto(photo)"
      >
        <div class="admin-thumb" @click="openLightbox(photo)">
          <img v-if="photo.import_status === 'ready'" :src="photo.thumb_url" :alt="photo.display_name" loading="lazy" />
          <div v-else class="thumb-placeholder">{{ statusLabel(photo) }}</div>
          <input class="pick" type="checkbox" :checked="selected.includes(photo.id)" :aria-label="'选择 ' + photo.display_name" @click.stop @change="toggleSelect(photo.id)" />
          <span v-if="photo.version > 1" class="badge version">v{{ photo.version }}</span>
          <span v-if="photo.hidden" class="badge hidden-badge">隐藏</span>
          <span v-if="photo.selected_count" class="badge count-badge" title="选择人数">选 {{ photo.selected_count }}</span>
          <span v-if="photo.comment_count" class="badge comment-badge" title="评论数">评 {{ photo.comment_count }}</span>
          <span v-if="photo.slot_names" class="badge slot-badge" :title="photo.slot_names">相框</span>
        </div>
        <div class="admin-photo-meta">
          <b :title="photo.display_name">{{ photo.display_name }}</b>
          <small v-if="photo.display_name !== photo.filename">原：{{ photo.filename }}</small>
          <small v-if="trash">删除于 {{ (photo.deleted_at || '').slice(0, 10) }} · 剩余 {{ photo.trash_remaining_days }} 天</small>
        </div>
        <div class="admin-photo-actions">
          <template v-if="!trash">
            <button type="button" @click="renamePhoto(photo)">重命名</button>
            <button type="button" @click="toggleHidden(photo)">{{ photo.hidden ? '显示' : '隐藏' }}</button>
            <button type="button" @click="replacePhoto(photo)">替换</button>
            <button type="button" class="danger-text" @click="deletePhoto(photo)">删除</button>
          </template>
          <button v-else type="button" @click="restorePhoto(photo)">恢复</button>
        </div>
      </article>
    </div>

    <input ref="photoInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png" @change="onFilesPicked" />
    <input ref="folderInput" class="visually-hidden" type="file" webkitdirectory directory multiple @change="onFolderPicked" />
    <input ref="replaceInput" class="visually-hidden" type="file" accept=".jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png" @change="onReplacePicked" />

    <div v-if="lightbox" class="lightbox admin-lightbox" @click.self="lightbox = null">
      <button class="close" type="button" @click="lightbox = null">×</button>
      <div class="lightbox-body">
        <img v-if="lightbox.import_status === 'ready'" :src="lightbox.preview_url" :alt="lightbox.display_name" />
        <div class="watermark">名人婚纱 · 预览</div>
      </div>
      <aside class="lightbox-info">
        <b>{{ lightbox.display_name }}</b>
        <p v-if="lightbox.display_name !== lightbox.filename" class="muted">原始文件名：{{ lightbox.filename }}</p>
        <p>选择：{{ lightbox.selected_names || '暂无人选择' }}</p>
        <p>评论：{{ lightbox.comment_count || 0 }} 条</p>
        <p v-if="lightbox.slot_names">用途：{{ lightbox.slot_names }}</p>
        <p class="muted">版本 v{{ lightbox.version || 1 }} · {{ lightbox.width }} × {{ lightbox.height }}</p>
      </aside>
    </div>
  </div>
</template>
