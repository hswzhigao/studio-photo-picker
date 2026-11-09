<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../../api';

const route = useRoute();
const router = useRouter();
const jobId = computed(() => Number(route.params.id));
const review = ref(null), loading = ref(true), error = ref(''), message = ref('');
const acceptedOverage = ref(false), busy = ref(false);
const quota = computed(() => review.value?.quota || { count: 0, quota: 0, overage: 0, overageAmount: 0 });
const products = computed(() => review.value?.products || []);
const problems = computed(() => review.value?.problems || []);
const canSubmit = computed(() => review.value?.can_submit && !review.value?.job?.status?.match(/locked|retouching|delivered/) && !review.value?.me?.submitted_at);
const submitted = computed(() => Boolean(review.value?.me?.submitted_at));
const overageBlocked = computed(() => quota.value.overage > 0 && !acceptedOverage.value);

async function load() {
  loading.value = true;
  try {
    const data = await api.get(`/api/client/jobs/${jobId.value}/review`);
    review.value = data;
    error.value = '';
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
async function adopt(product) {
  try {
    await api.patch(`/api/client/jobs/${jobId.value}/photos/${product.suggestion.photo_id}/slot`, { job_item_id: product.item.id });
    message.value = `已采纳 ${product.suggestion.selector_name} 的建议`;
    await load();
  } catch (e) { error.value = e.message; }
}
async function submit() {
  if (overageBlocked.value) { error.value = '请先确认接受加片金额'; return; }
  busy.value = true;
  try {
    await api.post(`/api/client/jobs/${jobId.value}/submit`, { accept_overage: quota.value.overage > 0 && acceptedOverage.value });
    message.value = '已提交，影楼确认后开始修图。';
    await load();
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function withdraw() {
  busy.value = true;
  try {
    await api.post(`/api/client/jobs/${jobId.value}/withdraw`);
    message.value = '已撤回，可继续修改。';
    await load();
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
function productSuggestion(product) {
  return (product.suggestions || []).find(suggestion => suggestion.selector_id === review.value?.me?.id) || (product.suggestions || [])[0] || null;
}
watch(jobId, load, { immediate: true });
onMounted(load);
</script>

<template>
  <div class="review-page">
    <header class="page-head">
      <div><p class="eyebrow">提交前确认</p><h1>{{ review?.job?.title || '' }}</h1><p class="muted">核对额度、产品指定和备注后再提交。</p></div>
      <div class="actions"><button class="button ghost" @click="router.push(`/jobs/${jobId}`)">返回选片</button><button class="button ghost" @click="router.push(`/jobs/${jobId}/selected`)">我的选片</button></div>
    </header>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div v-if="message" class="alert success">{{ message }}</div>
    <div v-if="loading" class="loading">正在核对…</div>
    <template v-else-if="review">
      <section class="summary-band">
        <div class="summary-metric" :class="{ danger: quota.overage }"><b>{{ quota.count }} / {{ quota.quota }}</b><small>精修照片</small></div>
        <div v-if="quota.overage" class="summary-metric danger"><b>+{{ quota.overage }}</b><small>加片 ¥{{ quota.overageAmount }}</small></div>
        <div v-for="product in products" :key="product.item.id" class="summary-metric"><b>{{ product.final ? '已指定' : '未指定' }}</b><small>{{ product.item.name }}</small></div>
      </section>

      <section v-if="problems.length" class="card problem-card">
        <h2>待处理问题</h2>
        <ul>
          <li v-for="(problem, index) in problems" :key="index">
            <template v-if="problem.code === 'OVERAGE'">超出套餐 {{ problem.count }} 张，加片 ¥{{ problem.amount }}，到店结算。</template>
            <template v-else-if="problem.code === 'PRODUCT_UNASSIGNED'">{{ problem.item.name }} 还没有指定照片。</template>
            <template v-else-if="problem.code === 'SLOT_CONFLICT'">产品 {{ problem.job_item_id }} 有冲突，请检查。</template>
          </li>
        </ul>
      </section>

      <section v-for="product in products" :key="product.item.id" class="card product-review">
        <div class="section-head"><h2>{{ product.item.name }}</h2><span class="muted">{{ product.final ? '已指定' : '未指定' }}</span></div>
        <div v-if="product.final" class="product-final">
          <img v-if="product.final.photo_id" :src="`/media/previews/${product.final.photo_id}.webp`" :alt="product.final.display_name || product.final.filename" />
          <div><b>{{ product.final.display_name || product.final.filename }}</b><p class="muted">由 {{ product.final.selector_name }} 指定</p></div>
        </div>
        <div v-if="product.suggestions?.length" class="suggestions">
          <p class="eyebrow">建议</p>
          <div v-for="suggestion in product.suggestions" :key="suggestion.photo_id" class="suggestion-row">
            <span>{{ suggestion.selector_name }} 建议 {{ suggestion.display_name || suggestion.filename }}</span>
            <button class="button ghost small" @click="adopt({ item: product.item, suggestion })">采纳</button>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>选片进度</h2>
        <div class="people">
          <article v-for="person in (review.submitted || [])" :key="person.id" class="person-card">
            <div class="person-top"><span class="avatar">{{ person.name?.slice(0, 1) }}</span><div><b>{{ person.name }}</b></div><span class="status">{{ person.submitted_at ? '已提交' : '选片中' }}</span></div>
          </article>
        </div>
      </section>

      <section class="card review-actions">
        <label v-if="quota.overage" class="inline-check"><input v-model="acceptedOverage" type="checkbox" /> 我接受超出套餐 {{ quota.overage }} 张，加片 ¥{{ quota.overageAmount }}，到店结算</label>
        <div class="actions">
          <button v-if="submitted" class="button ghost" :disabled="busy" @click="withdraw">撤回提交</button>
          <button v-else-if="review.can_submit" class="button primary" :disabled="busy || overageBlocked" @click="submit">确认提交</button>
          <span v-else class="muted">当前账号为仅选片，不能提交。</span>
        </div>
        <p v-if="overageBlocked" class="over-text">请先勾选接受加片金额。</p>
      </section>
    </template>
  </div>
</template>
