<script setup>
import { inject } from 'vue';

const client = inject('client');
</script>

<template>
  <main class="workspace client-home">
    <section class="card">
      <h1>我的选片任务</h1>
      <p class="muted">选择任务开始选片；已提交的可以撤回修改。</p>
      <div v-if="!client.jobs.length" class="empty-state">还没有选片任务，请等待影楼发布。</div>
      <div class="client-job-list">
        <router-link v-for="job in client.jobs" :key="job.id" class="client-job-card" :to="`/jobs/${job.id}`">
          <h2>{{ job.title }}</h2>
          <p class="muted">{{ job.submitted ? '已提交' : job.status === 'locked' ? '已锁定' : job.status === 'retouching' ? '修图中' : job.status === 'delivered' ? '已交付' : job.status === 'submitted' ? '影楼确认中' : '选片中' }} · 截止 {{ (job.deadline_at || '').slice(0, 10) }}</p>
        </router-link>
      </div>
    </section>
  </main>
</template>
