<script setup>
import { computed, inject, onMounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { generateReadablePassword, loginInfoText } from '../../utils/password';

const ctx = inject('jobContext');
const name = ref(''), phone = ref(''), permission = ref('select_submit'), error = ref(''), message = ref('');
const customers = ref([]), customerId = ref(''), query = ref('');
const newCustomer = reactive({ name: '', phone: '', password: '' });
const loginCard = ref(null), copied = ref(false);
const filteredCustomers = computed(() => {
  const q = query.value.trim();
  if (!q) return customers.value;
  return customers.value.filter(customer => `${customer.name}${customer.phone}`.includes(q));
});

async function loadCustomers() {
  try { const data = await api.get('/api/admin/customers'); customers.value = data.customers || []; }
  catch (e) { error.value = e.message; }
}
function pickCustomer() {
  const customer = customers.value.find(item => String(item.id) === String(customerId.value));
  if (customer) { name.value = customer.name; phone.value = customer.phone; }
}
async function add() {
  if (!name.value.trim() || !phone.value.trim()) { error.value = '请填写姓名和手机号'; return; }
  try {
    await api.post(`/api/admin/jobs/${ctx.jobId}/selectors`, {
      customer_id: customerId.value ? Number(customerId.value) : undefined,
      name: name.value.trim(), phone: phone.value.trim(), permission: permission.value,
    });
    name.value = ''; phone.value = ''; customerId.value = '';
    await ctx.refresh();
    message.value = '选片人已加入';
  } catch (e) { error.value = e.message; }
}
async function createAndAdd() {
  if (!newCustomer.name.trim() || !/^1\d{10}$/.test(newCustomer.phone)) { error.value = '请填写客户姓名和 11 位手机号'; return; }
  try {
    const result = await api.post('/api/admin/customers', {
      name: newCustomer.name.trim(), phone: newCustomer.phone,
      ...(newCustomer.password ? { password: newCustomer.password } : {}),
    });
    loginCard.value = { ...result.customer, password: result.password };
    await api.post(`/api/admin/jobs/${ctx.jobId}/selectors`, { customer_id: result.customer.id, permission: permission.value });
    newCustomer.name = ''; newCustomer.phone = ''; newCustomer.password = '';
    await loadCustomers();
    await ctx.refresh();
    message.value = '客户已创建并加入订单，请复制登录信息发给客户。';
  } catch (e) { error.value = e.message; }
}
async function copyLogin() {
  try { await navigator.clipboard.writeText(loginInfoText(loginCard.value)); copied.value = true; setTimeout(() => { copied.value = false; }, 1500); }
  catch { error.value = '复制失败，请长按密码复制'; }
}
async function remove(selector) {
  if (!window.confirm(`确定移除选片人 ${selector.name}？已有选择会被删除。`)) return;
  try { await api.del(`/api/admin/jobs/${ctx.jobId}/selectors/${selector.id}`, { confirm: true }); await ctx.refresh(); }
  catch (e) { error.value = e.message; }
}
async function toggleShare(selector) {
  try { await api.patch(`/api/admin/jobs/${ctx.jobId}/selectors/${selector.id}`, { share_selection: !selector.share_selection }); await ctx.refresh(); }
  catch (e) { error.value = e.message; }
}
async function changePermission(selector, value) {
  try { await api.patch(`/api/admin/jobs/${ctx.jobId}/selectors/${selector.id}`, { permission: value }); await ctx.refresh(); }
  catch (e) { error.value = e.message; }
}
onMounted(loadCustomers);
</script>

<template>
  <div>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div v-if="message" class="alert success">{{ message }}</div>
    <section class="card">
      <h2>添加选片人</h2>
      <div class="inline-form">
        <input v-model="query" placeholder="搜索客户姓名 / 手机号" />
        <select v-model="customerId" @change="pickCustomer">
          <option value="">从客户选择</option>
          <option v-for="customer in filteredCustomers" :key="customer.id" :value="customer.id">{{ customer.name }}（{{ customer.phone }}）</option>
        </select>
        <input v-model="name" placeholder="姓名" />
        <input v-model="phone" inputmode="tel" placeholder="手机号" />
        <select v-model="permission"><option value="select_submit">选片 + 提交</option><option value="select_only">仅选片</option></select>
        <button class="button primary" @click="add">添加</button>
      </div>
      <div class="rule-line"></div>
      <p class="eyebrow">客户还没有账号？当场新建并加入</p>
      <div class="inline-form">
        <input v-model="newCustomer.name" placeholder="客户姓名" />
        <input v-model="newCustomer.phone" inputmode="tel" placeholder="手机号" />
        <input v-model="newCustomer.password" minlength="8" autocomplete="new-password" placeholder="密码（留空自动生成）" />
        <button class="button ghost" @click="newCustomer.password = generateReadablePassword()">随机生成</button>
        <button class="button dark" @click="createAndAdd">新建客户并加入</button>
      </div>
      <section v-if="loginCard" class="password-card">
        <b>客户登录信息（仅显示一次）</b>
        <strong>{{ loginCard.password }}</strong>
        <span>{{ loginCard.name }} · {{ loginCard.phone }}</span>
        <button class="button ghost" @click="copyLogin">{{ copied ? '已复制' : '复制登录信息' }}</button>
      </section>
    </section>
    <section class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>姓名</th><th>手机号</th><th>权限</th><th>公开选择</th><th>提交</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="selector in ctx.selectors" :key="selector.id">
              <td>{{ selector.name }}</td>
              <td>{{ selector.phone }}</td>
              <td>
                <select :value="selector.permission" @change="changePermission(selector, $event.target.value)">
                  <option value="select_submit">选片 + 提交</option>
                  <option value="select_only">仅选片</option>
                </select>
              </td>
              <td><button class="button ghost small" @click="toggleShare(selector)">{{ selector.share_selection ? '公开' : '不公开' }}</button></td>
              <td>{{ selector.submitted_at || '未提交' }}</td>
              <td><button class="button ghost small" @click="remove(selector)">移除</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
