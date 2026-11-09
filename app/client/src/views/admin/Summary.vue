<script setup>
import { computed, inject } from 'vue';
import { useRouter } from 'vue-router';

const ctx = inject('jobContext');
const router = useRouter();
const summary = computed(() => ctx.summary || {});
const quota = computed(() => ({ count: summary.value.mergedCount || 0, quota: summary.value.quota || 0, over: summary.value.over || 0, amount: summary.value.amount || 0 }));
const products = computed(() => summary.value.products || []);
const problems = computed(() => summary.value.problems || []);
function openSelected() { router.push(`/admin/jobs/${ctx.jobId}/photos?filter=selected`); }
</script>

<template>
  <div>
    <section class="summary-band">
      <div class="summary-metric"><b>{{ quota.count }} / {{ quota.quota }}</b><small>精修照片</small></div>
      <div class="summary-metric" :class="{ danger: quota.over }"><b>{{ quota.over }}</b><small>超出 {{ quota.over ? `¥${quota.amount}` : '0 元' }}</small></div>
      <div v-for="product in products" :key="product.item.id" class="summary-metric"><b>{{ product.final ? '1' : '0' }} / {{ product.item.quantity }}</b><small>{{ product.item.name }}</small></div>
      <button class="button ghost" @click="openSelected">在照片页查看已选 {{ quota.count }} 张</button>
    </section>

    <div v-if="problems.length" class="card problem-card">
      <h2>待处理问题</h2>
      <ul>
        <li v-for="(problem, index) in problems" :key="index">
          <template v-if="problem.code === 'OVERAGE'">超出套餐 {{ problem.count }} 张，加片 ¥{{ problem.amount }}，到店结算。</template>
          <template v-else-if="problem.code === 'PRODUCT_UNASSIGNED'">{{ problem.item.name }} 还没有指定照片。</template>
          <template v-else-if="problem.code === 'SLOT_CONFLICT'">{{ problem.job_item_id }} 有 {{ problem.count }} 张同时为最终结果，请检查。</template>
        </li>
      </ul>
    </div>

    <section class="people">
      <article v-for="person in (summary.selectors || [])" :key="person.id" class="person-card">
        <div class="person-top">
          <span class="avatar" :style="{ background: `hsl(${(person.id * 67) % 360} 48% 42%)` }">{{ person.name?.slice(0, 1) }}</span>
          <div><b>{{ person.name }}</b><small>{{ person.permission === 'select_only' ? '仅选片' : '选片 + 提交' }}</small></div>
          <span class="status">{{ person.submitted_at ? '已提交' : '选片中' }}</span>
        </div>
        <div class="person-stats">
          <span>精修 <strong>{{ person.selectionCount || 0 }}</strong></span>
          <span>{{ person.share_selection ? '向他人公开' : '不公开' }}</span>
        </div>
      </article>
    </section>

    <section class="card admin-tools">
      <div class="section-head">
        <h2>订单操作</h2>
        <div class="actions">
          <button class="button ghost" @click="ctx.refresh()">刷新汇总</button>
          <router-link class="button ghost" :to="`/admin/jobs/${ctx.jobId}/comments`">查看评论</router-link>
          <router-link class="button ghost" :to="`/admin/jobs/${ctx.jobId}/logs`">通知 / 审计</router-link>
        </div>
      </div>
    </section>
  </div>
</template>
