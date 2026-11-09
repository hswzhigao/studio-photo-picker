<script setup>
import { onMounted, provide, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';

const router = useRouter();
const route = useRoute();
const admin = reactive({ ready: false, actor: null, mustChange: false, error: '' });
const navOpen = ref(false);
const phone = ref(''), password = ref(''), currentPassword = ref(''), newPassword = ref(''), busy = ref(false), showPassword = ref(false);
provide('admin', admin);

async function load() {
  admin.error = '';
  try {
    const identity = await api.get('/api/auth/me');
    if (!identity.actor || identity.actor.actor_type !== 'staff') { admin.actor = null; admin.mustChange = false; return; }
    admin.actor = identity.actor;
    admin.mustChange = Boolean(identity.actor.must_change_password);
  } catch (e) { admin.error = e.message || '后台暂不可用'; }
  finally { admin.ready = true; }
}
async function login() {
  busy.value = true;
  try {
    const result = await api.post('/api/admin/login', { phone: phone.value.trim(), password: password.value });
    admin.mustChange = Boolean(result.must_change_password);
    if (!admin.mustChange) await load();
    password.value = '';
  } catch (e) { admin.error = e.message || '登录失败'; }
  finally { busy.value = false; }
}
async function changePassword() {
  busy.value = true;
  try {
    await api.post('/api/admin/change-password', { current_password: currentPassword.value, new_password: newPassword.value });
    currentPassword.value = ''; newPassword.value = '';
    await load();
  } catch (e) { admin.error = e.message || '修改密码失败'; }
  finally { busy.value = false; }
}
async function logout() {
  await api.post('/api/auth/logout').catch(() => {});
  admin.actor = null;
  router.push('/admin');
}
watch(() => route.path, () => { navOpen.value = false; });
onMounted(load);
</script>

<template>
  <div class="admin-shell">
    <button v-if="admin.actor" class="admin-menu-toggle" aria-label="打开后台菜单" @click="navOpen = true">☰ 菜单</button>
    <div v-if="navOpen" class="admin-nav-backdrop" @click="navOpen = false"></div>
    <aside v-if="admin.actor" class="admin-nav" :class="{ open: navOpen }">
      <div class="brand light">名人婚纱 <small>后台</small></div>
      <router-link to="/admin" exact-active-class="active">选片订单</router-link>
      <router-link to="/admin/new-job" active-class="active">新建选片任务</router-link>
      <router-link to="/admin/customers" active-class="active">客户账号</router-link>
      <router-link to="/admin/templates" active-class="active">套餐模板</router-link>
      <router-link v-if="admin.actor.role === 'admin'" to="/admin/staff" active-class="active">员工账号</router-link>
      <router-link v-if="admin.actor.role === 'admin'" to="/admin/settings" active-class="active">系统设置</router-link>
      <a class="nav-logout" @click="logout">退出登录</a>
    </aside>
    <main class="admin-main">
      <div v-if="!admin.ready" class="loading">正在检查登录状态…</div>
      <div v-else-if="!admin.actor && !admin.mustChange" class="login-wrap">
        <div class="login-card">
          <div class="brand">名人婚纱 · 后台</div>
          <h1>员工登录</h1>
          <label>手机号<input v-model="phone" inputmode="tel" /></label>
          <label for="admin-login-password">密码</label><div class="password-row"><input id="admin-login-password" v-model="password" :type="showPassword ? 'text' : 'password'" @keyup.enter="login" /><button type="button" class="password-toggle" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div>
          <button class="button primary full" :disabled="busy" @click="login">进入后台</button>
          <div v-if="admin.error" class="alert danger">{{ admin.error }}</div>
        </div>
      </div>
      <div v-else-if="admin.mustChange" class="login-wrap">
        <div class="login-card">
          <h1>首次登录请修改密码</h1>
          <label>当前密码<input v-model="currentPassword" type="password" /></label>
          <label>新密码</label><div class="password-row"><input v-model="newPassword" :type="showPassword ? 'text' : 'password'" /><button type="button" class="password-toggle" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div>
          <button class="button primary full" :disabled="busy" @click="changePassword">保存新密码</button>
          <div v-if="admin.error" class="alert danger">{{ admin.error }}</div>
        </div>
      </div>
      <template v-else>
        <div v-if="admin.error" class="alert danger">{{ admin.error }}</div>
        <router-view />
      </template>
    </main>
  </div>
</template>
