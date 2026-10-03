import DefaultTheme from 'vitepress/theme-without-fonts';
import type { Theme } from 'vitepress';
import Landing from './Landing.vue';
import GuideList from './GuideList.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Landing', Landing);
    app.component('GuideList', GuideList);
  },
} satisfies Theme;
