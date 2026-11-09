<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../../api';
import { filterPhotos } from '../../state';

const client = inject('client');
const route = useRoute();
const router = useRouter();
const jobId = computed(() => Number(route.params.id));
const job = ref(null), photos = ref([]), me = ref(null);
const loading = ref(true), error = ref(''), filter = ref('all');
const lightbox = ref(null), note = ref('');
const tab = ref('selection');
const comments = ref([]), commentText = ref(''), commentVisibility = ref('all'), replyTo = ref(null);
const editingId = ref(null), editingText = ref('');
const commentError = ref('');
const toast = ref('');
let toastTimer = null, pollTimer = null, lastEventId = 0, touchStart = null;

const productItems = computed(() => (job.value?.items || []).filter(item => item.kind === 'print_from_retouch'));
const quota = computed(() => {
  const data = job.value?.quota || {};
  return { count: Number(data.count || 0), quota: Number(data.quota || 0), over: Number(data.overage || 0), amount: Number(data.overageAmount || 0) };
});
const expired = computed(() => Boolean(job.value?.deadline_at && new Date(job.value.deadline_at).getTime() < Date.now()));
const canEdit = computed(() => job.value?.status === 'selecting' && !expired.value);
const statusText = computed(() => {
  if (!job.value) return '';
  if (['locked', 'retouching', 'delivered'].includes(job.value.status)) return '已锁定，选择不可修改';
  if (job.value.status === 'submitted') return '已提交，可撤回';
  if (expired.value) return '已过截止时间';
  return '选片中';
});
const deadlineText = computed(() => {
  if (!job.value?.deadline_at) return '未设置截止时间';
  const date = new Date(job.value.deadline_at);
  const diff = date.getTime() - Date.now();
  const text = date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (diff < 0) return `已截止（${text}）`;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return `截止 ${text}（${days > 0 ? `${days} 天` : ''}${hours} 小时）`;
});
const shownPhotos = computed(() => filterPhotos(photos.value, filter.value));
const productCount = itemId => photos.value.filter(photo => (photo.slots || []).some(slot => slot.job_item_id === itemId)).length;
const hasProduct = (photo, item) => (photo.slots || []).some(slot => slot.job_item_id === item.id);
const topComments = computed(() => comments.value.filter(comment => !comment.parent_id));
const repliesFor = id => comments.value.filter(comment => comment.parent_id === id);

function showToast(message, type = 'success') {
  toast.value = { message, type };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 2600);
}
async function load() {
  if (!jobId.value) return;
  loading.value = true;
  try {
    const data = await api.get(`/api/client/jobs/${jobId.value}`);
    job.value = { ...data.job, quota: data.quota, selectors: data.selectors, items: data.items, download: data.download };
    photos.value = data.photos || [];
    me.value = data.me || client.actor;
    error.value = '';
  } catch (e) { error.value = e.message || '任务加载失败'; }
  finally { loading.value = false; }
}
async function refresh() {
  if (!jobId.value) return;
  try {
    const data = await api.get(`/api/client/jobs/${jobId.value}`);
    job.value = { ...data.job, quota: data.quota, selectors: data.selectors, items: data.items, download: data.download };
    photos.value = data.photos || [];
    me.value = data.me || me.value;
  } catch {}
}
async function pollChanges() {
  if (document.hidden || !jobId.value) return;
  try {
    const data = await api.get(`/api/client/jobs/${jobId.value}/changes?after=${lastEventId}`);
    const events = data.events || [];
    if (events.length) {
      lastEventId = Math.max(...events.map(event => event.id));
      await refresh();
      if (lightbox.value) await loadComments();
    }
  } catch {}
}
function startPolling() { clearInterval(pollTimer); pollTimer = setInterval(pollChanges, 10000); }

async function toggle(photo) {
  if (!canEdit.value) { showToast(statusText.value, 'error'); return; }
  const before = photo.selected;
  photo.selected = !before;
  try {
    await api.patch(`/api/client/jobs/${jobId.value}/photos/${photo.id}/selection`, { selected: !before });
    await refresh();
    showToast(!before ? '已选为精修' : '已取消选择');
  } catch (e) { photo.selected = before; showToast(e.message, 'error'); }
}
async function setProduct(photo, item) {
  if (!canEdit.value) { showToast(statusText.value, 'error'); return; }
  const current = hasProduct(photo, item);
  const before = { selected: photo.selected, slots: [...(photo.slots || [])] };
  photo.slots = current ? photo.slots.filter(slot => slot.job_item_id !== item.id) : [...(photo.slots || []), { job_item_id: item.id, name: item.name }];
  photo.selected = true;
  try {
    await api.patch(`/api/client/jobs/${jobId.value}/photos/${photo.id}/slot`, { job_item_id: item.id, ...(current ? { remove: true, slot: null } : {}) });
    await refresh();
    showToast(current ? `已取消${item.name}` : `已设为${item.name}`);
  } catch (e) { photo.selected = before.selected; photo.slots = before.slots; showToast(e.message, 'error'); }
}
async function saveNote() {
  if (!lightbox.value) return;
  try {
    await api.patch(`/api/client/jobs/${jobId.value}/photos/${lightbox.value.id}/note`, { content: note.value });
    lightbox.value.my_note = note.value;
    showToast('备注已保存');
  } catch (e) { showToast(e.message, 'error'); }
}
async function setShare(event) {
  try {
    await api.patch(`/api/client/jobs/${jobId.value}/me`, { share_selection: event.target.checked });
    await refresh();
    showToast(event.target.checked ? '已向其他人公开选择' : '已取消公开');
  } catch (e) { event.target.checked = !event.target.checked; showToast(e.message, 'error'); }
}
async function openPhoto(photo) {
  lightbox.value = photo;
  note.value = photo.my_note || '';
  tab.value = 'selection';
  commentText.value = '';
  commentVisibility.value = me.value?.share_selection ? 'all' : 'studio_only';
  replyTo.value = null;
  editingId.value = null;
  commentError.value = '';
  await loadComments();
  await markCommentsRead();
}
async function loadComments() {
  if (!lightbox.value) return;
  try {
    const data = await api.get(`/api/client/jobs/${jobId.value}/photos/${lightbox.value.id}/comments`);
    comments.value = data.comments || [];
  } catch (e) { commentError.value = e.message; }
}
async function markCommentsRead() {
  if (!lightbox.value) return;
  try {
    await api.post(`/api/client/jobs/${jobId.value}/comments/read`);
    lightbox.value.unread_comment_count = 0;
  } catch {}
}
function closePhoto() { lightbox.value = null; editingId.value = null; replyTo.value = null; }
async function postComment() {
  if (!commentText.value.trim()) return;
  try {
    await api.post(`/api/client/jobs/${jobId.value}/photos/${lightbox.value.id}/comments`, {
      content: commentText.value.trim(),
      visibility: commentVisibility.value,
      ...(replyTo.value ? { parent_id: replyTo.value } : {}),
    });
    commentText.value = '';
    replyTo.value = null;
    await loadComments();
    await refresh();
    showToast('评论已发送');
  } catch (e) { commentError.value = e.message; }
}
function startReply(comment) { replyTo.value = comment.id; }
function startEdit(comment) { editingId.value = comment.id; editingText.value = comment.content; }
async function saveEdit(comment) {
  try {
    await api.patch(`/api/client/jobs/${jobId.value}/photos/${lightbox.value.id}/comments/${comment.id}`, { content: editingText.value });
    editingId.value = null;
    await loadComments();
    await refresh();
    showToast('评论已更新');
  } catch (e) { commentError.value = e.message; }
}
async function deleteComment(comment) {
  if (!window.confirm('确定删除这条评论？')) return;
  try { await api.del(`/api/client/jobs/${jobId.value}/photos/${lightbox.value.id}/comments/${comment.id}`); await loadComments(); await refresh(); }
  catch (e) { commentError.value = e.message; }
}
function authorName(comment) { return comment.author_type === 'staff' ? '影楼' : (comment.author_id === me.value?.id ? '我' : '选片人'); }
function canEditComment(comment) { return comment.author_type === 'customer' && comment.author_id === me.value?.id && Date.now() - Date.parse(comment.created_at) <= 300000; }
function visibilityText(comment) { return comment.visibility === 'studio_only' ? '仅影楼可见' : '所有人可见'; }
function goSelected() { router.push(`/jobs/${jobId.value}/selected`); }
function goReview() { router.push(`/jobs/${jobId.value}/review`); }
function touchStartHandler(event) { const touch = event.touches[0]; touchStart = { x: touch.clientX, y: touch.clientY }; }
function touchEndHandler(event) {
  if (!touchStart || !lightbox.value) return;
  const touch = event.changedTouches[0], dx = touch.clientX - touchStart.x, dy = touch.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) keydown({ key: 'ArrowRight' }); else keydown({ key: 'ArrowLeft' }); }
  else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closePhoto();
}
function keydown(event) {
  if (!lightbox.value) return;
  const index = photos.value.findIndex(photo => photo.id === lightbox.value.id);
  if (event.key === 'Escape') closePhoto();
  if (event.key === 'ArrowRight' && index < photos.value.length - 1) openPhoto(photos.value[index + 1]);
  if (event.key === 'ArrowLeft' && index > 0) openPhoto(photos.value[index - 1]);
  if (event.key === ' ') { event.preventDefault(); toggle(lightbox.value); }
}
watch(jobId, async () => { lastEventId = 0; await load(); startPolling(); }, { immediate: true });
onMounted(() => window.addEventListener('keydown', keydown));
onUnmounted(() => { window.removeEventListener('keydown', keydown); clearInterval(pollTimer); clearTimeout(toastTimer); });
</script>

<template>
  <div class="client-job-page">
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div v-if="loading" class="loading">正在准备照片…</div>
    <template v-else-if="job">
      <div class="client-job-head">
        <div><h1>{{ job.title }}</h1><p class="muted">{{ deadlineText }}</p></div>
        <div class="status-bar" :class="{ locked: !canEdit, submitted: job.status === 'submitted' }">{{ statusText }}</div>
      </div>
      <div class="mobile-quota">
        <div><b>{{ quota.count }}/{{ quota.quota }}</b><small>精修照片</small></div>
        <div v-for="item in productItems" :key="item.id"><b>{{ productCount(item.id) }}/{{ item.quantity }}</b><small>{{ item.name }}</small></div>
      </div>
      <main class="workspace">
        <aside class="quota-panel">
          <p class="eyebrow">套餐额度</p>
          <div class="quota-big" :class="{ over: quota.over }">{{ quota.count }} <span>/ {{ quota.quota }}</span></div>
          <div class="progress"><i :style="{ width: Math.min(100, quota.count / Math.max(1, quota.quota) * 100) + '%' }"></i></div>
          <p class="muted">精修照片 <b>{{ quota.quota }} 张</b></p>
          <div v-if="quota.over" class="overage">已超出 {{ quota.over }} 张<br>加片 ¥{{ quota.amount }}，到店结算</div>
          <div v-for="item in productItems" :key="item.id" class="product-quota"><span>{{ item.name }}</span><b>{{ productCount(item.id) }} / {{ item.quantity }}</b></div>
          <button class="button primary full side-action" @click="goSelected">我的选片</button>
          <button v-if="me?.permission === 'select_submit'" class="button dark full side-action" @click="goReview">查看并提交</button>
          <div class="side-rule"></div>
          <p class="eyebrow">一起选片</p>
          <div v-for="person in (job.selectors || [])" :key="person.id" class="selector-row">
            <span class="avatar small" :style="{ background: `hsl(${(person.id * 67) % 360} 48% 42%)` }">{{ person.name?.slice(0, 1) }}</span>
            <span>{{ person.name }}<small>{{ person.id === me?.id ? '我' : (person.share_selection ? '已公开' : '未公开') }}</small></span>
            <b>{{ person.selectionCount ?? '—' }}</b>
          </div>
          <label class="share"><span>让其他人看到我的选择<small>影楼始终可以看到</small></span><input type="checkbox" :checked="me?.share_selection" :disabled="!canEdit" @change="setShare" /></label>
        </aside>
        <section class="photo-area">
          <div class="toolbar">
            <div class="filters">
              <button v-for="item in [['all','全部'],['mine','我已选'],['unpicked','未选'],['print','相框 / 摆台'],['partner','他人选的'],['commented','有评论']]" :key="item[0]" :class="{ selected: filter === item[0] }" @click="filter = item[0]">{{ item[1] }} <small>{{ filterPhotos(photos, item[0]).length }}</small></button>
            </div>
            <span class="tip">点击照片看大图 · 右键上角 ✓ 选为精修</span>
          </div>
          <div class="photo-grid">
            <article v-for="photo in shownPhotos" :key="photo.id" class="photo-card" :class="{ picked: photo.selected }">
              <div class="photo-image" @click="openPhoto(photo)">
                <img :src="photo.thumb_url" :alt="photo.display_name || photo.filename" loading="lazy" />
                <button class="check" :aria-label="photo.selected ? '取消精修' : '选为精修'" :disabled="!canEdit" @click.stop="toggle(photo)">{{ photo.selected ? '✓' : '' }}</button>
                <div class="tags"><span v-for="item in productItems.filter(product => hasProduct(photo, product))" :key="item.id">{{ item.name }}</span></div>
                <span v-if="photo.others?.length" class="partner">{{ photo.others[0].name }}也选了</span>
                <span v-if="photo.comment_count" class="card-comment">{{ photo.comment_count }}<i v-if="photo.unread_comment_count" class="red-dot"></i></span>
              </div>
              <div class="photo-footer">
                <span>{{ photo.display_name || photo.filename }}</span>
                <div>
                  <button v-for="item in productItems" :key="item.id" :class="{ on: hasProduct(photo, item) }" :disabled="!canEdit" @click="setProduct(photo, item)">{{ item.name.replace('30寸','').replace('10寸','') }}</button>
                </div>
              </div>
            </article>
          </div>
        </section>
      </main>
      <footer class="mobile-submit">
        <span>选择会自动保存<br><small>{{ canEdit ? '截止前可修改' : statusText }}</small></span>
        <button class="button dark" @click="goReview">{{ me?.permission === 'select_submit' ? '查看并提交' : '查看我的选片' }}</button>
        <button class="button ghost" @click="goSelected">我的选片</button>
      </footer>
    </template>

    <div v-if="lightbox" class="lightbox" @click.self="closePhoto" @touchstart.passive="touchStartHandler" @touchend.passive="touchEndHandler">
      <button class="close" @click="closePhoto">×</button>
      <button class="nav prev" @click="keydown({ key: 'ArrowLeft' })">‹</button>
      <div class="lightbox-body"><img :src="lightbox.preview_url" :alt="lightbox.display_name || lightbox.filename" /><div class="watermark">名人婚纱 · 预览</div></div>
      <button class="nav next" @click="keydown({ key: 'ArrowRight' })">›</button>
      <aside class="lightbox-info client-lightbox-info">
        <b>{{ lightbox.display_name || lightbox.filename }}</b>
        <div class="lightbox-tabs client-tabs">
          <button :class="{ active: tab === 'selection' }" @click="tab = 'selection'">选择</button>
          <button :class="{ active: tab === 'comments' }" @click="tab = 'comments'">评论 {{ lightbox.comment_count || 0 }}</button>
          <button :class="{ active: tab === 'notes' }" @click="tab = 'notes'">我的备注</button>
        </div>
        <div v-if="tab === 'selection'" class="lightbox-panel">
          <button class="button primary full" :disabled="!canEdit" @click="toggle(lightbox)">{{ lightbox.selected ? '✓ 已选为精修' : '选为精修' }}</button>
          <div class="slot-actions"><button v-for="item in productItems" :key="item.id" :class="{ on: hasProduct(lightbox, item) }" :disabled="!canEdit" @click="setProduct(lightbox, item)">{{ item.name }}</button></div>
          <p v-if="lightbox.others?.length" class="muted">其他人也选了：{{ lightbox.others.map(person => person.name).join('、') }}</p>
          <p class="muted">{{ deadlineText }}</p>
        </div>
        <div v-else-if="tab === 'comments'" class="lightbox-panel">
          <div v-if="commentError" class="alert danger">{{ commentError }}</div>
          <div v-if="!topComments.length" class="muted">还没有评论。</div>
          <article v-for="comment in topComments" :key="comment.id" class="lightbox-comment">
            <div class="comment-head"><b>{{ authorName(comment) }}</b><span class="comment-visibility">{{ visibilityText(comment) }}</span><small>{{ (comment.created_at || '').replace('T', ' ').slice(0, 16) }}</small></div>
            <template v-if="editingId === comment.id"><textarea v-model="editingText" rows="2"></textarea><button class="button ghost small" @click="saveEdit(comment)">保存</button></template>
            <p v-else>{{ comment.content }}</p>
            <div class="comment-actions">
              <button class="button ghost small" @click="startReply(comment)">回复</button>
              <button v-if="canEditComment(comment)" class="button ghost small" @click="startEdit(comment)">编辑</button>
              <button v-if="canEditComment(comment)" class="button ghost small danger-text" @click="deleteComment(comment)">删除</button>
            </div>
            <article v-for="reply in repliesFor(comment.id)" :key="reply.id" class="comment-reply">
              <b>{{ authorName(reply) }}</b><small>{{ (reply.created_at || '').slice(11, 16) }}</small>
              <p>{{ reply.content }}</p>
            </article>
          </article>
          <div class="reply-box">
            <p v-if="replyTo" class="muted">回复评论 #{{ replyTo }} <button class="link-button" @click="replyTo = null">取消</button></p>
            <textarea v-model="commentText" rows="3" placeholder="写评论…" :disabled="['locked','retouching','delivered'].includes(job?.status)"></textarea>
            <label v-if="!replyTo" class="inline-check"><input v-model="commentVisibility" type="checkbox" true-value="studio_only" false-value="all" /> 仅影楼可见</label>
            <button class="button primary full" :disabled="['locked','retouching','delivered'].includes(job?.status)" @click="postComment">发表评论</button>
            <p class="muted">锁定后仍可以评论，但不能修改选择。</p>
          </div>
        </div>
        <div v-else class="lightbox-panel">
          <p class="eyebrow">给修图师的备注</p>
          <textarea v-model="note" rows="5" placeholder="例如：背景路人去掉，皮肤自然一点"></textarea>
          <button class="button ghost full" :disabled="!canEdit" @click="saveNote">保存备注</button>
        </div>
      </aside>
    </div>
    <div v-if="toast" class="toast" :class="toast.type">{{ toast.message }}</div>
  </div>
</template>
