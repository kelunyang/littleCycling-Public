import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'welcome',
      component: () => import('./views/WelcomeView.vue'),
    },
    {
      path: '/game',
      name: 'game',
      component: () => import('./views/GameView.vue'),
    },
  ],
});

// Guard: prevent direct access to /game without starting from welcome
router.beforeEach((to) => {
  if (to.name === 'game') {
    // GameView itself handles the redirect if state !== 'playing'
    // This is a safety net for direct URL access
    return true;
  }
  return true;
});

export default router;
