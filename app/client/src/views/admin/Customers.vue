<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { generateReadablePassword, loginInfoText } from '../../utils/password';

const customers = ref([]);
const query = ref('');
const name = ref(''), phone = ref(''), password = ref('');
const passwordCard = ref(null), copied = ref(false), error = ref('');
async function load() {
  try { const data = await api.get(`/api/admin/customers?q=${encodeURIComponent(query.value)}`); customers.value = data.customers || []; }
  catch (e) { error.value = e.message; }
}
async function create() {
  try {
    const result = await api.post('/api/admin/customers', { name: name.value.trim(), phone: phone.value.trim(), ...(password.value ? { password: password.value } : {}) });
    passwordCard.value = { type: '客户', ...result.customer, password: result.password };
    name.value = ''; phone.value = ''; password.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}
async function reset(customer) {
  try { const result = await api.post(`/api/admin/customers/${customer.id}/reset-password`); passwordCard.value = { type: '重置', ...customer, password: result.password, url: result.url }; copied.value = false; }
  catch (e) { error.value = e.message; }
}
async function toggle(customer) {
  try { await api.patch(`/api/admin/customers/${customer.id}`, { status: customer.status === 'active' ? 'disabled' : 'active' }); await load(); }
  catch (e) { error.value = e.message; }
}
async function copy() {
  const text = loginInfoText(passwordCard.value);
  try { await navigator.clipboard.writeText(text); copied.value = true; setTimeout(() => { copied.value = false; }, 1500); } catch { error.value = '复制失败'; }
}
onMounted(load);
</script>

<template>
  <div>
    <header class="page-head"><div><p class="eyebrow">后台 / 客户账号</p><h1>客户账号</h1></div><div class="actions"><input v-model="query" placeholder="搜索姓名或手机号" @keyup.enter="load" /><button class="button ghost" @click="load">搜索</button></div></header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <section class="card"><h2>新建客户</h2><div class="inline-form"><input v-model="name" placeholder="客户姓名" /><input v-model="phone" inputmode="tel" placeholder="手机号" /><input v-model="password" minlength="8" autocomplete="new-password" placeholder="密码（可留空自动生成）" /><button class="button ghost" @click="password = generateReadablePassword()">随机生成</button><button class="button primary" @click="create">创建客户</button></div></section>
    <section v-if="passwordCard" class="card password-card"><b>{{ passwordCard.type }}登录信息（仅显示一次）</b><strong>{{ passwordCard.password }}</strong><span>{{ passwordCard.name }} · {{ passwordCard.phone }}</span><button class="button ghost" @click="copy">{{ copied ? '已复制' : '复制登录信息' }}</button></section>
    <section class="card"><div class="table-wrap"><table><thead><tr><th>客户</th><th>手机号</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="customer in customers" :key="customer.id"><td>{{ customer.name }}</td><td>{{ customer.phone }}</td><td>{{ customer.status === 'active' ? '正常' : '已停用' }}</td><td class="actions"><button class="button ghost small" @click="reset(customer)">重置密码</button><button class="button ghost small" @click="toggle(customer)">{{ customer.status === 'active' ? '停用' : '启用' }}</button></td></tr></tbody></table></div></section>
  </div>
</template>
