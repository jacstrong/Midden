<script setup lang="ts">
import { useData, withBase } from 'vitepress';
import type { Guide } from '../guides';

const { theme } = useData();
const guides = theme.value.guides as Guide[];
</script>

<template>
  <div class="guides">
    <a v-for="g in guides" :key="g.link" class="guide notch" :href="withBase(g.link)">
      <b>{{ g.title }}</b>
      <span>{{ g.summary }}</span>
      <i aria-hidden="true">Open →</i>
    </a>
  </div>
</template>

<style scoped>
.guides {
  display: grid;
  gap: 14px;
  margin-top: 24px;
}
.vp-doc a.guide {
  display: block;
  padding: 18px 20px 16px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 3px solid var(--cy);
  text-decoration: none;
  color: var(--ink);
  transition: 0.14s;
}
.vp-doc a.guide:hover {
  background: var(--panel2);
  box-shadow: 0 0 22px rgba(34, 232, 255, 0.12);
}
.guide b {
  display: block;
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--cy);
  margin-bottom: 6px;
}
.guide span {
  display: block;
  color: var(--dim);
  font-size: 14px;
  line-height: 1.6;
}
.guide i {
  display: block;
  margin-top: 10px;
  font-style: normal;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--dimmer);
}
.guide:hover i {
  color: var(--cy);
}
</style>
