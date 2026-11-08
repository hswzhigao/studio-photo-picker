import { createRouter, createWebHistory, createMemoryHistory } from 'vue-router';
import AppView from './views/AppView.vue';

export const routes = [
  { path: '/', component: AppView },
  { path: '/jobs/:id', component: AppView },
  { path: '/jobs/:id/selected', component: AppView },
  { path: '/admin', component: AppView },
  { path: '/:pathMatch(.*)*', component: AppView },
];

export const router = createRouter({ history: typeof window === 'undefined' ? createMemoryHistory() : createWebHistory(), routes });
