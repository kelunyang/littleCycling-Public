// vue-cdn-shim.mjs — CDN Vue 橋接
//
// index.html 的 import map 把 "vue" 指到本檔。esm.sh 上的 md-editor-v3
// （以 ?external=vue 打包）在瀏覽器裡 `import ... from "vue"` 時會載入這裡,
// 我們把 app 在 main.ts 掛上 window 的同一份 Vue（window.__vueForCdn）原樣轉發,
// 確保整個頁面只有一個 Vue 實例（兩份 Vue 會壞 reactivity）。
//
// 具名匯出清單由 packages/web 下 `node -e "import('vue').then(...)"` 產生;
// 若某個名字在瀏覽器的 Vue 上不存在,解構只會得到 undefined（不會拋錯）,
// 而 md-editor-v3 用不到的內部符號本就不會被讀取,失敗模式安全。

const V = /** @type {any} */ (window.__vueForCdn);

if (!V) {
  throw new Error('[vue-cdn-shim] window.__vueForCdn 未設定;main.ts 尚未執行?');
}

export const {
  BaseTransition, BaseTransitionPropsValidators, Comment, DeprecationTypes, EffectScope,
  ErrorCodes, ErrorTypeStrings, Fragment, KeepAlive, ReactiveEffect, Static, Suspense,
  Teleport, Text, TrackOpTypes, Transition, TransitionGroup, TriggerOpTypes, VueElement,
  assertNumber, callWithAsyncErrorHandling, callWithErrorHandling, camelize, capitalize,
  cloneVNode, compatUtils, compile, computed, createApp, createBlock, createCommentVNode,
  createElementBlock, createElementVNode, createHydrationRenderer, createPropsRestProxy,
  createRenderer, createSSRApp, createSlots, createStaticVNode, createTextVNode, createVNode,
  customRef, defineAsyncComponent, defineComponent, defineCustomElement, defineEmits,
  defineExpose, defineModel, defineOptions, defineProps, defineSSRCustomElement, defineSlots,
  devtools, effect, effectScope, getCurrentInstance, getCurrentScope, getCurrentWatcher,
  getTransitionRawChildren, guardReactiveProps, h, handleError, hasInjectionContext, hydrate,
  hydrateOnIdle, hydrateOnInteraction, hydrateOnMediaQuery, hydrateOnVisible,
  initCustomFormatter, initDirectivesForSSR, inject, isMemoSame, isProxy, isReactive,
  isReadonly, isRef, isRuntimeOnly, isShallow, isVNode, markRaw, mergeDefaults, mergeModels,
  mergeProps, nextTick, nodeOps, normalizeClass, normalizeProps, normalizeStyle, onActivated,
  onBeforeMount, onBeforeUnmount, onBeforeUpdate, onDeactivated, onErrorCaptured, onMounted,
  onRenderTracked, onRenderTriggered, onScopeDispose, onServerPrefetch, onUnmounted, onUpdated,
  onWatcherCleanup, openBlock, patchProp, popScopeId, provide, proxyRefs, pushScopeId,
  queuePostFlushCb, reactive, readonly, ref, registerRuntimeCompiler, render, renderList,
  renderSlot, resolveComponent, resolveDirective, resolveDynamicComponent, resolveFilter,
  resolveTransitionHooks, setBlockTracking, setDevtoolsHook, setTransitionHooks,
  shallowReactive, shallowReadonly, shallowRef, ssrContextKey, ssrUtils, stop, toDisplayString,
  toHandlerKey, toHandlers, toRaw, toRef, toRefs, toValue, transformVNodeArgs, triggerRef,
  unref, useAttrs, useCssModule, useCssVars, useHost, useId, useModel, useSSRContext,
  useShadowRoot, useSlots, useTemplateRef, useTransitionState, vModelCheckbox, vModelDynamic,
  vModelRadio, vModelSelect, vModelText, vShow, version, warn, watch, watchEffect,
  watchPostEffect, watchSyncEffect, withAsyncContext, withCtx, withDefaults, withDirectives,
  withKeys, withMemo, withModifiers, withScopeId,
} = V;

export default V;
