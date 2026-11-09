<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { filterPhotos, quotaLabel, selectedPhotoCount, submissionPayload } from '../state';

const route = useRoute();
const router = useRouter();
const path = computed(() => route.path);
const jobId = computed(() => Number(path.value.match(/^\/jobs\/(\d+)/)?.[1] || 0));
const me = ref(null), jobs = ref([]), job = ref(null), photos = ref([]);
const loading = ref(true), error = ref(''), filter = ref('all'), lightbox = ref(null), note = ref('');
const mustChange = ref(false), currentPassword = ref(''), newPassword = ref('');
const phone = ref(''), otp = ref(''), loginName = ref('');
const isSelectedPage = computed(() => /^\/jobs\/\d+\/selected$/.test(path.value));
const selectedTab = ref('mine'), selectedPhotos = ref([]), packages = ref([]), wechatHint = ref(false), pollTimer = ref(null), clientPollTimer = ref(null);
async function loadSelected() { const data = await api.get(`/api/client/jobs/${jobId.value}/selected?tab=${selectedTab.value}`); selectedPhotos.value = data.photos || []; wechatHint.value = Boolean(data.wechat); }
async function createPackage(scope='selected_preview') { try { const result = await api.post(`/api/client/jobs/${jobId.value}/packages`, { scope }); packages.value.unshift(result.package); pollPackages(); } catch (e) { error.value = e.message; } }
async function pollPackages() { if (document.hidden || !packages.value.length) return; for (const item of packages.value.filter(p => p.status === 'pending')) { const data = await api.get(`/api/client/jobs/${jobId.value}/packages/${item.id}`); Object.assign(item, data.package); } }
function selectedNavigate(tab) { selectedTab.value = tab; loadSelected(); }

const selectedCount = computed(() => selectedPhotoCount({ quota: job.value?.quota, photos: photos.value }));
const quota = computed(() => quotaLabel(selectedCount.value, job.value?.quota?.retouch || 20));
const shownPhotos = computed(() => filterPhotos(photos.value, filter.value));

async function loadClient() {
  loading.value = true;
  try {
    const identity = await api.get('/api/auth/me'); me.value = identity.actor;
    if (identity.actor?.must_change_password) { mustChange.value = true; return; }
    const list = await api.get('/api/client/jobs'); jobs.value = list.jobs || [];
    const selectedJobId = jobId.value || jobs.value[0]?.id;
    if (!selectedJobId) { me.value = identity.actor; return; }
    const data = await api.get(`/api/client/jobs/${selectedJobId}`); me.value = { ...(data.me || {}), ...(identity.actor || {}) }; job.value = { ...data.job, quota: data.quota, selectors: data.selectors, items: data.items, original_download_scope: data.download?.original_download_scope || data.job?.original_download_scope };
    photos.value = data.photos || []; error.value = '';
  } catch (e) { error.value = e.message || '请先登录'; } finally { loading.value = false; }
}
async function refreshClient() {
  if (!job.value?.id) return;
  try {
    const data = await api.get(`/api/client/jobs/${job.value.id}`);
    job.value = { ...data.job, quota: data.quota, selectors: data.selectors, items: data.items, original_download_scope: data.download?.original_download_scope || data.job?.original_download_scope };
    photos.value = data.photos || [];
  } catch { /* 轮询失败时保留当前页面，不打断选片 */ }
}
function startClientPolling() {
  clearInterval(clientPollTimer.value);
  clientPollTimer.value = setInterval(() => { if (!document.hidden && !isSelectedPage.value) refreshClient(); }, 10000);
}
async function login() {
  error.value = '';
  try { const result = await api.post('/api/auth/login', { phone: phone.value, password: otp.value }); mustChange.value = Boolean(result.must_change_password); await loadClient(); } catch (e) { error.value = e.message || '登录失败'; }
}
async function changePassword() { try { await api.post('/api/auth/change-password', { current_password: currentPassword.value, new_password: newPassword.value }); mustChange.value = false; await loadClient(); } catch (e) { error.value = e.message || '修改密码失败'; } }
function navigate(to) { router.push(to); }
function startPolling() { clearInterval(pollTimer.value); pollTimer.value = setInterval(() => { if (!document.hidden && isSelectedPage.value) { loadSelected(); pollPackages(); } }, 2000); }

async function toggle(photo) {
  if (job.value?.status === 'locked') return;
  try { await api.patch(`/api/client/jobs/${job.value.id}/photos/${photo.id}/selection`, { selected: !photo.selected }); photo.selected = !photo.selected; } catch (e) { error.value = e.message; }
}
async function setSlot(photo, slot) {
  try { const current = photo.slots?.find(s => s.name?.includes(slot === 'frame' ? '相框' : '摆台')); await api.patch(`/api/client/jobs/${job.value.id}/photos/${photo.id}/slot`, { slot: photo.slot === slot ? null : slot, job_item_id: current?.job_item_id }); photo.slot = photo.slot === slot ? null : slot; photo.selected = true; } catch (e) { error.value = e.message; }
}
async function saveNote() { if (!lightbox.value) return; try { await api.patch(`/api/client/jobs/${job.value.id}/photos/${lightbox.value.id}/note`, { content: note.value }); lightbox.value.my_note = note.value; } catch (e) { error.value = e.message; } }
async function submit() { try { const acceptsOverage = quota.value.over === 0 || window.confirm(`已超出套餐 ${quota.value.over} 张，加片 ¥${quota.value.amount}，到店结算。确认提交吗？`); await api.post(`/api/client/jobs/${job.value.id}/submit`, submissionPayload(quota.value, acceptsOverage)); alert('已提交，影楼确认后开始修图。'); } catch (e) { error.value = e.message; } }
function openPhoto(photo) { lightbox.value = photo; note.value = photo.note || ''; }
function closePhoto() { lightbox.value = null; }
function keydown(e) { if (!lightbox.value) return; const index = photos.value.findIndex(p => p.id === lightbox.value.id); if (e.key === 'Escape') closePhoto(); if (e.key === 'ArrowRight') openPhoto(photos.value[Math.min(index + 1, photos.value.length - 1)]); if (e.key === 'ArrowLeft') openPhoto(photos.value[Math.max(index - 1, 0)]); if (e.key === ' ') { e.preventDefault(); toggle(lightbox.value); } }
function loadCurrentRoute() { if (isSelectedPage.value) { loadClient().then(() => { loadSelected(); startPolling(); }); } else loadClient().then(() => startClientPolling()); }
onMounted(() => { window.addEventListener('keydown', keydown); loadCurrentRoute(); });
watch(() => route.fullPath, () => { clearInterval(pollTimer.value); clearInterval(clientPollTimer.value); loadCurrentRoute(); });
onUnmounted(() => { window.removeEventListener('keydown', keydown); clearInterval(pollTimer.value); clearInterval(clientPollTimer.value); });
</script>

<template>
  <div class="client-shell">
    <div v-if="!me" class="login-wrap"><div class="login-card"><div class="brand">名人婚纱</div><p class="eyebrow">ONLINE PHOTO SELECTION</p><h1>选出属于你们的<br><em>精彩瞬间</em></h1><p class="muted">从底片中选出精修照片，与家人一起完成最终选择。</p><label>手机号<input v-model="phone" inputmode="tel" /></label><label>密码<input v-model="otp" type="password" /></label><button class="button primary full" @click="login">进入选片</button><div v-if="error" class="alert danger">{{ error }}</div></div></div>
    <div v-else-if="mustChange" class="login-wrap"><div class="login-card"><h1>首次登录请修改密码</h1><label>当前密码<input v-model="currentPassword" type="password" /></label><label>新密码<input v-model="newPassword" type="password" /></label><button class="button primary full" @click="changePassword">保存新密码</button><div v-if="error" class="alert danger">{{ error }}</div></div></div>
    <template v-else-if="isSelectedPage"><header class="client-header"><div><button class="button ghost" @click="navigate(`/jobs/${jobId}`)">返回选片</button><div class="brand">名人婚纱</div><h1>我的选片</h1></div></header><main class="workspace selected-page"><div class="filters"><button v-for="item in [['mine','我选的'],['final','最终结果'],['products','相框 / 摆台']]" :key="item[0]" :class="{ selected: selectedTab === item[0] }" @click="selectedNavigate(item[0])">{{ item[1] }}</button></div><p v-if="wechatHint" class="alert">请点右上角 ··· 选择“在浏览器打开”后下载，单张图可长按保存。</p><div class="photo-grid"><article v-for="photo in selectedPhotos" :key="photo.id" class="photo-card"><img :src="photo.preview_url" :alt="photo.display_name || photo.filename" /><div class="photo-footer"><span>{{ photo.display_name || photo.filename }}</span><a class="button ghost" :href="photo.preview_url">下载预览</a><a v-if="job?.status === 'locked' && job?.allow_original_download && job?.original_download_scope !== 'none'" class="button ghost" :href="`/api/client/jobs/${job.id}/photos/${photo.id}/original`">下载原片</a></div></article></div><div class="download-actions"><button class="button primary" @click="createPackage('selected_preview')">打包下载水印预览</button><button v-if="job?.status === 'locked' && job?.allow_original_download && job?.original_download_scope === 'all'" class="button ghost" @click="createPackage('all_original')">下载全部原片</button><button v-else-if="job?.status === 'locked' && job?.allow_original_download && job?.original_download_scope !== 'none'" class="button ghost" @click="createPackage('selected_original')">打包下载原片</button><p v-for="item in packages" :key="item.id"><span>{{ item.status }}</span> <a v-if="item.status === 'ready'" :href="item.file_url">下载 ZIP</a></p></div></main></template><template v-else><header class="client-header"><nav><button v-for="item in jobs" :key="item.id" class="button ghost" @click="navigate(`/jobs/${item.id}`)">{{ item.title }}</button></nav><div><div class="brand">名人婚纱</div><h1>{{ job?.title || '示例 · 婚纱照' }}</h1></div><div class="deadline">截止 {{ job?.deadlineLabel || '7 天后' }}</div></header><div class="mobile-quota"><div><b>{{ quota.count }}/{{ quota.quota }}</b><small>精修照片</small></div><div><b>{{ photos.filter(p => p.slot === 'frame').length }}/1</b><small>30寸相框</small></div><div><b>{{ photos.filter(p => p.slot === 'desk').length }}/1</b><small>10寸摆台</small></div></div><div v-if="error" class="alert danger">{{ error }}</div><main class="workspace"><aside class="quota-panel"><p class="eyebrow">套餐额度</p><div class="quota-big" :class="{ over: quota.over }">{{ quota.count }} <span>/ {{ quota.quota }}</span></div><div class="progress"><i :style="{ width: Math.min(100, quota.count / quota.quota * 100) + '%' }"></i></div><p class="muted">精修照片 <b>{{ quota.quota }} 张</b></p><div v-if="quota.over" class="overage">已超出 {{ quota.over }} 张<br>加片 ¥{{ quota.amount }}，到店结算</div><div class="side-rule"></div><p class="eyebrow">一起选片</p><div v-for="person in (job?.selectors || [])" :key="person.id" class="selector-row"><span class="avatar small">{{ person.name?.slice(0,1) }}</span><span>{{ person.name }}<small>{{ person.id === me?.id ? '我' : (person.share_selection ? '已公开' : '未公开') }}</small></span><b>{{ person.selectionCount || '—' }}</b></div><label class="share"><span>让其他人看到我的选择<small>影楼始终可以看到</small></span><input type="checkbox" :checked="me.share_selection" @change="api.patch(`/api/client/jobs/${job.id}/me`, { share_selection: $event.target.checked }).then(() => loadClient())" /></label></aside><section class="photo-area"><div class="toolbar"><div class="filters"><button v-for="item in [['all','全部'],['mine','我已选'],['unpicked','未选'],['print','相框 / 摆台'],['partner','他人选的']]" :key="item[0]" :class="{ selected: filter === item[0] }" @click="filter=item[0]">{{ item[1] }} <small>{{ filterPhotos(photos,item[0]).length }}</small></button></div><span class="tip">点击照片看大图 · 右上角 ✓ 选为精修</span></div><div v-if="loading" class="loading">正在准备照片…</div><div v-else class="photo-grid"><article v-for="photo in shownPhotos" :key="photo.id" class="photo-card" :class="{ picked: photo.selected }"><div class="photo-image" @click="openPhoto(photo)"><img :src="photo.thumb_url" :alt="photo.display_name || photo.filename" loading="lazy" /><button class="check" :aria-label="photo.selected ? '取消精修' : '选为精修'" @click.stop="toggle(photo)">{{ photo.selected ? '✓' : '' }}</button><div class="tags"><span v-if="photo.slot === 'frame'">30寸相框</span><span v-if="photo.slot === 'desk'">10寸摆台</span></div><span v-if="photo.others?.length" class="partner">{{ photo.others[0].name }}也选了</span></div><div class="photo-footer"><span>{{ photo.display_name || photo.filename }}</span><div><button :class="{ on: photo.slot === 'frame' }" @click="setSlot(photo, 'frame')">相框</button><button :class="{ on: photo.slot === 'desk' }" @click="setSlot(photo, 'desk')">摆台</button></div></div></article></div></section></main><footer class="mobile-submit"><span>选择会自动保存<br><small>截止前可修改</small></span><button class="button dark" @click="submit">去提交</button><a v-if="job?.status === 'locked' && job?.allow_original_download && job?.original_download_scope !== 'none'" class="button ghost" href="#" @click.prevent="api.post(`/api/client/jobs/${job.id}/originals.zip`).then(d => window.location.href=d.url)">下载原片</a></footer></template>
  </div>
  <div v-if="lightbox" class="lightbox" @click.self="closePhoto"><button class="close" @click="closePhoto">×</button><button class="nav prev" @click="keydown({key:'ArrowLeft'})">‹</button><div class="lightbox-body"><img :src="lightbox.preview_url" :alt="lightbox.filename"/><div class="watermark">名人婚纱 · 预览</div></div><button class="nav next" @click="keydown({key:'ArrowRight'})">›</button><aside class="lightbox-info"><b>{{ lightbox.display_name || lightbox.filename }}</b><button class="button primary" @click="toggle(lightbox)">{{ lightbox.selected ? '✓ 已选为精修' : '选为精修' }}</button><div class="slot-actions"><button :class="{ on: lightbox.slot === 'frame' }" @click="setSlot(lightbox,'frame')">相框</button><button :class="{ on: lightbox.slot === 'desk' }" @click="setSlot(lightbox,'desk')">摆台</button></div><p class="eyebrow">给修图师的备注</p><textarea v-model="note" rows="4" placeholder="例如：背景路人去掉，皮肤自然一点"></textarea><button class="button ghost full" @click="saveNote">保存备注</button></aside></div>
</template>
