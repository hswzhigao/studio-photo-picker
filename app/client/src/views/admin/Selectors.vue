<script setup>
import { inject, onMounted, ref } from 'vue';
import { api } from '../../api';

const ctx = inject('jobContext');
const name = ref(''), phone = ref(''), permission = ref('select_submit'), error = ref('');
const customers = ref([]), customerId = ref('');
async function loadCustomers() { try { const data = await api.get('/api/admin/customers'); customers.value = data.customers || []; } catch {} }
function pickCustomer() { const customer = customers.value.find(item => String(item.id) === String(customerId.value)); if (customer) { name.value = customer.name; phone.value = customer.phone; } }
async function add() {
  try {
    await api.post(`/api/admin/jobs/${ctx.jobId}/selectors`, { customer_id: customerId.value ? Number(customerId.value) : undefined, name: name.value.trim(), phone: phone.value.trim(), permission: permission.value });
    name.value = ''; phone.value = ''; customerId.value = '';
    await ctx.refresh();
  } catch (e) { error.value = e.message; }
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
onMounted(loadCustomers);
</script>

<template>
  <div>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <section class="card">
      <h2>添加选片人</h2>
      <div class="inline-form">
        <select v-model="customerId" @change="pickCustomer"><option value="">从客户选择</option><option v-for="customer in customers" :key="customer.id" :value="customer.id">{{ customer.name }}（{{ customer.phone }}）</option></select>
        <input v-model="name" placeholder="姓名" />
        <input v-model="phone" inputmode="tel" placeholder="手机号" />
        <select v-model="permission"><option value="select_submit">选片 + 提交</option><option value="select_only">仅选片</option></select>
        <button class="button primary" @click="add">添加</button>
      </div>
    </section>
    <section class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>姓名</th><th>手机号</th><th>权限</th><th>公开选择</th><th>提交</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="selector in ctx.selectors" :key="selector.id">
              <td>{{ selector.name }}</td>
              <td>{{ selector.phone }}</td>
              <td>{{ selector.permission === 'select_only' ? '仅选片' : '选片 + 提交' }}</td>
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
