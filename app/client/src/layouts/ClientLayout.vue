<script setup>
import { onMounted, provide, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';

const route = useRoute();
const router = useRouter();
const client = reactive({ ready: false, actor: null, jobs: [], mustChange: false, error: '', toast: '', refreshJobs: null });
const phone = ref(''), password = ref(''), currentPassword = ref(''), newPassword = ref(''), busy = ref(false);
const meOpen = ref(false);
let toastTimer = null;

function showToast(message) {
  client.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { client.toast = ''; }, 2600);
}
async function loadJobs() {
  try {
    const data = await api.get('/api/client/jobs');
    client.jobs = data.jobs || [];
    if (!client.jobs.length && route.path !== '/') router.push('/');
  } catch (e) { client.error = e.message; }
}
async function loadSession() {
  client.error = '';
  try {
    const identity = await api.get('/api/auth/me');
    if (!identity.actor || identity.actor.actor_type !== 'customer') {
      client.actor = null;
      client.mustChange = false;
      client.ready = true;
      return;
    }
    client.actor = identity.actor;
    client.mustChange = Boolean(identity.actor.must_change_password);
    if (!client.mustChange) await loadJobs();
  } catch (e) { client.error = e.message || '请先登录'; }
  finally { client.ready = true; }
}
client.refreshJobs = loadJobs;
async function login() {
  busy.value = true;
  client.error = '';
  try {
    const result = await api.post('/api/auth/login', { phone: phone.value.trim(), password: password.value });
    client.mustChange = Boolean(result.must_change_password);
    if (!client.mustChange) await loadSession();
    password.value = '';
  } catch (e) { client.error = e.message || '登录失败'; }
  finally { busy.value = false; }
}
async function changePassword() {
  busy.value = true;
  try {
    await api.post('/api/auth/change-password', { current_password: currentPassword.value, new_password: newPassword.value });
    currentPassword.value = ''; newPassword.value = '';
    meOpen.value = false;
    await loadSession();
    showToast('密码已修改');
  } catch (e) { client.error = e.message || '修改密码失败'; }
  finally { busy.value = false; }
}
async function logout() {
  await api.post('/api/auth/logout').catch(() => {});
  client.actor = null;
  client.jobs = [];
  meOpen.value = false;
  router.push('/');
}
function openMe() { meOpen.value = true; }
onMounted(loadSession);
</script>

<template>
  <div class="client-shell">
    <div v-if="!client.ready" class="loading">正在加载…</div>
    <div v-else-if="!client.actor" class="login-wrap">
      <div class="login-card">
        <div class="brand">名人婚纱</div>
        <p class="eyebrow">ONLINE PHOTO SELECTION</p>
        <h1>选出属于你们的<br><em>精彩瞬间</em></h1>
        <p class="muted">从底片中选出精修照片，与家人一起完成最终选择。</p>
        <label>手机号<input v-model="phone" inputmode="tel" /></label>
        <label>密码<input v-model="password" type="password" @keyup.enter="login" /></label>
        <button class="button primary full" :disabled="busy" @click="login">进入选片</button>
        <div v-if="client.error" class="alert danger">{{ client.error }}</div>
      </div>
    </div>
    <div v-else-if="client.mustChange" class="login-wrap">
      <div class="login-card">
        <h1>首次登录请修改密码</h1>
        <label>当前密码<input v-model="currentPassword" type="password" /></label>
        <label>新密码<input v-model="newPassword" type="password" /></label>
        <button class="button primary full" :disabled="busy" @click="changePassword">保存新密码</button>
        <div v-if="client.error" class="alert danger">{{ client.error }}</div>
      </div>
    </div>
    <template v-else>
      <header class="client-header client-topbar">
        <div class="client-topbar-left">
          <div class="brand">名人婚纱</div>
          <nav v-if="client.jobs.length" class="job-nav">
            <router-link v-for="job in client.jobs" :key="job.id" :to="`/jobs/${job.id}`" class="button ghost">{{ job.title }}</router-link>
          </nav>
        </div>
        <div class="actions">
          <button class="button ghost" @click="openMe">我的</button>
        </div>
      </header>
      <div v-if="client.error" class="alert danger">{{ client.error }}</div>
      <router-view v-if="client.jobs.length || route.path === '/'" />
      <div v-else class="empty-state">还没有选片任务，请等待影楼发布。</div>
    </template>
    <div v-if="client.toast" class="toast">{{ client.toast }}</div>

    <div v-if="meOpen" class="modal-backdrop" @click.self="meOpen = false">
      <div class="modal me-modal">
        <button class="modal-close" @click="meOpen = false">×</button>
        <h2>我的</h2>
        <p><b>{{ client.actor.name }}</b> · {{ client.actor.phone }}</p>
        <p class="muted">首次登录后请修改密码；修改后其他设备需要重新登录。</p>
        <label>当前密码<input v-model="currentPassword" type="password" /></label>
        <label>新密码<input v-model="newPassword" type="password" /></label>
        <button class="button primary full" :disabled="busy" @click="changePassword">修改密码</button>
        <button class="button ghost full" @click="logout">退出登录</button>
        <div v-if="client.error" class="alert danger">{{ client.error }}</div>
      </div>
    </div>
  </div>
</template>
