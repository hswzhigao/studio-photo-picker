<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { generateReadablePassword } from '../../utils/password';

const staff = ref([]);
const name = ref(''), phone = ref(''), role = ref('editor'), password = ref('');
const card = ref(null), error = ref('');
async function load() {
  try { const data = await api.get('/api/admin/staff'); staff.value = data.staff || []; }
  catch (e) { error.value = e.message; }
}
async function create() {
  try {
    const result = await api.post('/api/admin/staff', { name: name.value.trim(), phone: phone.value.trim(), role: role.value, ...(password.value ? { password: password.value } : {}) });
    card.value = { name: result.staff.name, phone: result.staff.phone, password: result.password };
    name.value = ''; phone.value = ''; password.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}
async function reset(person) {
  try { const result = await api.post(`/api/admin/staff/${person.id}/reset-password`); card.value = { name: person.name, phone: person.phone, password: result.password }; }
  catch (e) { error.value = e.message; }
}
async function toggle(person) {
  try { await api.patch(`/api/admin/staff/${person.id}`, { status: person.status === 'active' ? 'disabled' : 'active' }); await load(); }
  catch (e) { error.value = e.message; }
}
onMounted(load);
</script>

<template>
  <div>
    <header class="page-head"><div><p class="eyebrow">后台 / 员工账号</p><h1>员工账号</h1></div></header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <section class="card"><h2>新建员工</h2><div class="inline-form"><input v-model="name" placeholder="姓名" /><input v-model="phone" inputmode="tel" placeholder="手机号" /><select v-model="role"><option value="editor">编辑</option><option value="admin">管理员</option></select><input v-model="password" minlength="8" autocomplete="new-password" placeholder="密码（可留空自动生成）" /><button class="button ghost" @click="password = generateReadablePassword()">随机生成</button><button class="button primary" @click="create">创建员工</button></div></section>
    <section v-if="card" class="card password-card"><b>员工登录信息（仅显示一次）</b><strong>{{ card.password }}</strong><span>{{ card.name }} · {{ card.phone }}</span></section>
    <section class="card"><div class="table-wrap"><table><thead><tr><th>姓名</th><th>手机号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="person in staff" :key="person.id"><td>{{ person.name }}</td><td>{{ person.phone }}</td><td>{{ person.role === 'admin' ? '管理员' : '编辑' }}</td><td>{{ person.status === 'active' ? '正常' : '已停用' }}</td><td class="actions"><button class="button ghost small" @click="reset(person)">重置密码</button><button class="button ghost small" @click="toggle(person)">{{ person.status === 'active' ? '停用' : '启用' }}</button></td></tr></tbody></table></div></section>
  </div>
</template>
