import { createRouter, createWebHistory, createMemoryHistory } from 'vue-router';
import ClientLayout from './layouts/ClientLayout.vue';
import ClientHome from './views/client/ClientHome.vue';
import ClientJob from './views/client/ClientJob.vue';
import ClientSelected from './views/client/ClientSelected.vue';
import ClientReview from './views/client/ClientReview.vue';
import AdminLayout from './layouts/AdminLayout.vue';
import JobList from './views/admin/JobList.vue';
import JobDetail from './views/admin/JobDetail.vue';
import Summary from './views/admin/Summary.vue';
import Photos from './views/admin/Photos.vue';
import Selectors from './views/admin/Selectors.vue';
import Comments from './views/admin/Comments.vue';
import JobSettings from './views/admin/JobSettings.vue';
import Logs from './views/admin/Logs.vue';
import Customers from './views/admin/Customers.vue';
import Staff from './views/admin/Staff.vue';
import Templates from './views/admin/Templates.vue';
import NewJob from './views/admin/NewJob.vue';
import AdminSettings from './views/admin/AdminSettings.vue';

export const routes = [
  {
    path: '/',
    component: ClientLayout,
    children: [
      { path: '', component: ClientHome },
      { path: 'jobs/:id', component: ClientJob },
      { path: 'jobs/:id/selected', component: ClientSelected },
      { path: 'jobs/:id/review', component: ClientReview },
    ],
  },
  {
    path: '/admin',
    component: AdminLayout,
    children: [
      { path: '', component: JobList },
      { path: 'new-job', component: NewJob },
      { path: 'customers', component: Customers },
      { path: 'staff', component: Staff },
      { path: 'templates', component: Templates },
      { path: 'settings', component: AdminSettings },
      {
        path: 'jobs/:id',
        component: JobDetail,
        children: [
          { path: '', redirect: 'summary' },
          { path: 'summary', component: Summary },
          { path: 'photos', component: Photos },
          { path: 'selectors', component: Selectors },
          { path: 'comments', component: Comments },
          { path: 'settings', component: JobSettings },
          { path: 'logs', component: Logs },
        ],
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({ history: typeof window === 'undefined' ? createMemoryHistory() : createWebHistory(), routes });
