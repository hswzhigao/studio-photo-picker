<script setup>
import { computed, inject, onMounted, reactive, ref } from 'vue';
import { api } from '../../api';

const ctx = inject('jobContext');
const comments = ref([]);
const photoNames = ref({});
const replyTexts = reactive({});
const error = ref('');

const groups = computed(() => {
  const map = new Map();
  for (const comment of comments.value) {
    if (!map.has(comment.photo_id)) map.set(comment.photo_id, []);
    map.get(comment.photo_id).push(comment);
  }
  return [...map.entries()].map(([photoId, list]) => ({ photoId, name: photoNames.value[photoId] || `照片 #${photoId}`, comments: list }));
});
const authorName = comment => comment.author_type === 'staff' ? '影楼' : `选片人 #${comment.author_id}`;

async function load() {
  try {
    const [data, photos] = await Promise.all([
      api.get(`/api/admin/jobs/${ctx.jobId}/comments`),
      api.get(`/api/admin/jobs/${ctx.jobId}/photos?page_size=200`),
    ]);
    comments.value = data.comments || [];
    photoNames.value = Object.fromEntries((photos.photos || []).map(photo => [photo.id, photo.display_name || photo.filename]));
    error.value = '';
  } catch (e) { error.value = e.message; }
}
async function reply(comment) {
  const content = String(replyTexts[comment.id] || '').trim();
  if (!content) return;
  try {
    await api.post(`/api/admin/jobs/${ctx.jobId}/photos/${comment.photo_id}/comments`, { content, parent_id: comment.parent_id ? comment.parent_id : comment.id });
    replyTexts[comment.id] = '';
    await load();
  } catch (e) { error.value = e.message; }
}
async function remove(comment) {
  if (!window.confirm('确定删除这条评论？')) return;
  try { await api.del(`/api/admin/jobs/${ctx.jobId}/photos/${comment.photo_id}/comments/${comment.id}`); await load(); }
  catch (e) { error.value = e.message; }
}
onMounted(load);
</script>

<template>
  <div>
    <div v-if="error" class="alert danger">{{ error }}</div>
    <div class="section-head"><h2>评论</h2><button class="button ghost" @click="load">刷新</button></div>
    <div v-if="!groups.length" class="empty-state">还没有评论。</div>
    <section v-for="group in groups" :key="group.photoId" class="card comment-group">
      <h3>{{ group.name }}</h3>
      <article v-for="comment in group.comments" :key="comment.id" class="comment-row" :class="{ deleted: comment.deleted_at }">
        <div class="comment-meta">
          <b>{{ authorName(comment) }}</b>
          <span class="status">{{ comment.visibility === 'studio_only' ? '仅影楼可见' : '公开' }}</span>
          <small>{{ (comment.created_at || '').replace('T', ' ').slice(0, 16) }}</small>
          <span v-if="comment.deleted_at" class="over-text">已删除</span>
        </div>
        <p>{{ comment.content }}</p>
        <div v-if="!comment.deleted_at" class="comment-actions">
          <input v-model="replyTexts[comment.id]" placeholder="回复这条评论…" @keyup.enter="reply(comment)" />
          <button class="button ghost small" @click="reply(comment)">回复</button>
          <button class="button ghost small danger-text" @click="remove(comment)">删除</button>
        </div>
      </article>
    </section>
  </div>
</template>
