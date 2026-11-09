<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';
import { generateReadablePassword, loginInfoText } from '../../utils/password';

const router = useRouter();
const step = ref(1), job = ref(null), busy = ref(false), error = ref(''), message = ref('');
const title = ref('');
const form = reactive({ deadline: '', retouch: 20, frame: 1, desk: 1, overage: true, price: 20, download: true, scope: 'selected' });
const sourceDirs = ref([]), source = ref(''), rootImages = ref(0), importTask = ref(null);
const selectors = ref([]), customers = ref([]), customerId = ref('');
const newCustomer = reactive({ name: '', phone: '', password: '' }), loginCard = ref(null), copied = ref(false);
let pollTimer = null;

const selectedCustomer = computed(() => customers.value.find(customer => String(customer.id) === String(customerId.value)));
const importPercent = computed(() => {
  const task = importTask.value;
  if (!task?.total) return 0;
  return Math.round(((task.processed || 0) / task.total) * 100);
});

async function loadTemplates() { /* 保留模板接口，产品行由本向导直接生成 */ }
async function loadSourceDirs() {
  try { const data = await api.get('/api/admin/source-dirs'); sourceDirs.value = data.directories || []; rootImages.value = data.root_image_count || 0; }
  catch (e) { error.value = e.message; }
}
async function loadSelectors() {
  if (!job.value) return;
  try {
    const [people, customerData] = await Promise.all([
      api.get(`/api/admin/jobs/${job.value.id}/selectors`),
      api.get('/api/admin/customers'),
    ]);
    selectors.value = people.selectors || [];
    customers.value = customerData.customers || [];
  } catch (e) { error.value = e.message; }
}
function applyTemplate(template) {
  if (!template) return;
  const items = template.items || [];
  const retouch = items.find(item => item.kind === 'retouch');
  const frame = items.find(item => item.name.includes('相框'));
  const desk = items.find(item => item.name.includes('摆台'));
  if (retouch) form.retouch = retouch.quantity;
  if (frame) form.frame = frame.quantity;
  if (desk) form.desk = desk.quantity;
}
async function createDraft() {
  if (!title.value.trim()) { error.value = '请填写订单标题'; return; }
  busy.value = true;
  try {
    const items = [
      { name: '精修照片', kind: 'retouch', quantity: Number(form.retouch) || 0 },
      { name: '30寸相框', kind: 'print_from_retouch', quantity: Number(form.frame) || 0 },
      { name: '10寸摆台', kind: 'print_from_retouch', quantity: Number(form.desk) || 0 },
    ].filter(item => item.quantity > 0);
    if (!items.length) { error.value = '至少设置一项产品数量'; return; }
    const result = await api.post('/api/admin/jobs', {
      title: title.value.trim(),
      deadline_at: form.deadline ? new Date(form.deadline).toISOString() : undefined,
      allow_overage: form.overage,
      overage_unit_price: Number(form.price) || 0,
      allow_original_download: form.download,
      original_download_scope: form.download ? form.scope : 'none',
      items,
    });
    job.value = result.job;
    step.value = 2;
    await loadSourceDirs();
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function startImport() {
  if (!source.value) { error.value = '请选择要导入的文件夹'; return; }
  busy.value = true;
  try {
    const result = await api.post(`/api/admin/jobs/${job.value.id}/imports`, { source: source.value });
    importTask.value = result.import_task;
    pollImport(result.import_task.id);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
function pollImport(taskId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const data = await api.get(`/api/admin/jobs/${job.value.id}/imports/${taskId}`);
      importTask.value = { ...importTask.value, ...data.import_task };
      if (['completed', 'failed'].includes(data.import_task.status)) clearInterval(pollTimer);
    } catch { clearInterval(pollTimer); }
  }, 800);
}
async function nextToSelectors() {
  clearInterval(pollTimer);
  step.value = 3;
  await loadSelectors();
}
async function addSelector() {
  if (!selectedCustomer.value) { error.value = '请选择客户'; return; }
  const customer = selectedCustomer.value;
  busy.value = true;
  try {
    await api.post(`/api/admin/jobs/${job.value.id}/selectors`, { customer_id: customer.id, permission: 'select_submit' });
    customerId.value = '';
    await loadSelectors();
    message.value = `已加入选片人 ${customer.name}`;
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function createCustomerAndAdd() {
  if (!newCustomer.name.trim() || !/^1\d{10}$/.test(newCustomer.phone)) { error.value = '请填写客户姓名和 11 位手机号'; return; }
  busy.value = true;
  try {
    const created = await api.post('/api/admin/customers', { name: newCustomer.name.trim(), phone: newCustomer.phone, ...(newCustomer.password ? { password: newCustomer.password } : {}) });
    loginCard.value = { ...created.customer, password: created.password };
    await api.post(`/api/admin/jobs/${job.value.id}/selectors`, { customer_id: created.customer.id, permission: 'select_submit' });
    newCustomer.name = ''; newCustomer.phone = ''; newCustomer.password = '';
    await loadSelectors();
    message.value = '客户已创建并加入本订单，请复制登录信息发给客户。';
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function copyLogin() {
  try { await navigator.clipboard.writeText(loginInfoText(loginCard.value)); copied.value = true; setTimeout(() => { copied.value = false; }, 1500); }
  catch { error.value = '复制失败，请长按密码复制'; }
}
async function publish() {
  busy.value = true;
  try {
    await api.patch(`/api/admin/jobs/${job.value.id}/publish`);
    router.push(`/admin/jobs/${job.value.id}/summary`);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
function saveDraft() { router.push(`/admin/jobs/${job.value.id}/summary`); }
onMounted(loadTemplates);
onBeforeUnmount(() => clearInterval(pollTimer));
</script>

<template>
  <div class="new-job-page">
    <header class="page-head">
      <div><p class="eyebrow">后台 / 新建选片订单</p><h1>新建订单</h1></div>
      <div class="wizard-steps">
        <span :class="{ active: step === 1 }">1 基本信息</span>
        <span :class="{ active: step === 2 }">2 导入照片</span>
        <span :class="{ active: step === 3 }">3 添加选片人</span>
      </div>
    </header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div v-if="message" class="alert success">{{ message }}</div>

    <section v-if="step === 1" class="card form-card">
      <label>订单标题<input v-model="title" placeholder="例如：廖府" /></label>
      <label>截止时间<input v-model="form.deadline" type="datetime-local" /></label>
      <div class="inline-form">
        <label>精修数量<input v-model.number="form.retouch" type="number" min="0" /></label>
        <label>30寸相框<input v-model.number="form.frame" type="number" min="0" /></label>
        <label>10寸摆台<input v-model.number="form.desk" type="number" min="0" /></label>
      </div>
      <div class="inline-form">
        <label class="inline-check"><input v-model="form.overage" type="checkbox" /> 允许加片</label>
        <label v-if="form.overage">加片单价<input v-model.number="form.price" type="number" min="0" /></label>
      </div>
      <label class="inline-check"><input v-model="form.download" type="checkbox" /> 允许客户下载原片</label>
      <label v-if="form.download">原片范围<select v-model="form.scope"><option value="selected">仅最终选片</option><option value="all">全部原片</option><option value="none">关闭</option></select></label>
      <button class="button primary" :disabled="busy" @click="createDraft">{{ busy ? '创建中…' : '下一步：导入照片' }}</button>
      <p class="muted">创建后会保存为草稿；照片和选片人添加完成后再发布。</p>
    </section>

    <section v-else-if="step === 2" class="card form-card">
      <h2>{{ job?.title }} · 导入照片</h2>
      <p class="muted">从服务器照片目录选择文件夹导入；导入过程中可以继续下一步。</p>
      <div class="inline-form">
        <select v-model="source">
          <option value="">选择文件夹（根目录 {{ rootImages }} 张）</option>
          <option v-for="dir in sourceDirs" :key="dir.name" :value="dir.name">{{ dir.name }}（{{ dir.image_count }} 张）</option>
        </select>
        <button class="button primary" :disabled="busy || importTask?.status === 'pending' || importTask?.status === 'processing'" @click="startImport">开始导入</button>
      </div>
      <div v-if="importTask" class="import-summary">
        <p>状态：{{ importTask.status === 'completed' ? '已完成' : importTask.status === 'failed' ? '失败' : '导入中' }} · {{ importTask.processed || 0 }} / {{ importTask.total || 0 }} 张<span v-if="importTask.failed"> · 失败 {{ importTask.failed }}</span></p>
        <div class="progress"><i :style="{ width: importPercent + '%' }"></i></div>
      </div>
      <div class="actions">
        <button class="button ghost" @click="nextToSelectors">跳过，下一步</button>
        <button class="button primary" @click="nextToSelectors">下一步：添加选片人</button>
      </div>
    </section>

    <template v-else>
      <section class="card form-card">
        <h2>添加选片人</h2>
        <p class="muted">从已有客户选择，或当场新建客户。新建客户的初始密码只显示一次。</p>
        <div class="inline-form">
          <select v-model="customerId"><option value="">选择已有客户</option><option v-for="customer in customers" :key="customer.id" :value="customer.id">{{ customer.name }}（{{ customer.phone }}）</option></select>
          <button class="button ghost" :disabled="busy || !customerId" @click="addSelector">加入订单</button>
        </div>
        <div class="rule-line"></div>
        <div class="inline-form">
          <input v-model="newCustomer.name" placeholder="新客户姓名" />
          <input v-model="newCustomer.phone" inputmode="tel" placeholder="手机号" />
          <input v-model="newCustomer.password" minlength="8" autocomplete="new-password" placeholder="密码（留空自动生成）" />
          <button class="button ghost" @click="newCustomer.password = generateReadablePassword()">随机生成</button>
          <button class="button dark" :disabled="busy" @click="createCustomerAndAdd">新建客户并加入</button>
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
            <thead><tr><th>姓名</th><th>手机号</th><th>权限</th><th>公开选择</th><th>提交</th></tr></thead>
            <tbody>
              <tr v-for="person in selectors" :key="person.id">
                <td>{{ person.name }}</td><td>{{ person.phone }}</td>
                <td>{{ person.permission === 'select_only' ? '仅选片' : '选片 + 提交' }}</td>
                <td>{{ person.share_selection ? '公开' : '不公开' }}</td>
                <td>{{ person.submitted_at || '未提交' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div class="actions wizard-actions">
        <button class="button ghost" @click="step = 2">上一步</button>
        <button class="button ghost" @click="saveDraft">保存草稿</button>
        <button class="button primary" :disabled="busy || !selectors.length" @click="publish">{{ busy ? '发布中…' : '发布订单' }}</button>
      </div>
    </template>
  </div>
</template>
