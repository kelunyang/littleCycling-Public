/**
 * markdown-cdn — 從 CDN 動態載入 md-editor-v3 的 MdPreview 與 DOMPurify sanitizer。
 *
 * user 指定走 CDN（免 npm install）。md-editor-v3 v6 沒有 UMD build,改用 esm.sh
 * 的 ESM CDN（`?external=vue` 讓其 `import "vue"` 透過 index.html 的 import map
 * 導向本地 shim,共用 app 的 Vue）。preview.css 從 jsdelivr 注入。
 *
 * 外部 runtime 來源（已於 DEVPLAN／plan 告知並取得 user 同意）:
 *   - esm.sh — md-editor-v3@6.5.3（MIT）、dompurify@3.4.11（Apache-2.0 / MPL 雙授權）
 *   - cdn.jsdelivr.net — md-editor-v3 preview.css
 * 離線時 loadMarkdownRenderer() 會 reject,呼叫端降級為純文字顯示。
 */

import type { Component } from 'vue';

// ── 釘死版本（勿隨意升版,升版前重驗 esm.sh 可用性與 sanitize 行為）──
const MD_URL = 'https://esm.sh/md-editor-v3@6.5.3?external=vue';
const DP_URL = 'https://esm.sh/dompurify@3.4.11';
const CSS_URL = 'https://cdn.jsdelivr.net/npm/md-editor-v3@6.5.3/lib/preview.css';

const LOAD_TIMEOUT_MS = 15_000;
const CSS_LINK_MARKER = 'data-md-preview-css';

export interface MarkdownRenderer {
  MdPreview: Component;
  sanitize: (html: string) => string;
}

// module-level promise cache:成功後多個 MarkdownView 共用同一次載入（即時渲染）;
// 失敗時清 cache,讓下次呼叫可重試。
let cache: Promise<MarkdownRenderer> | null = null;

/** 只注入一次 preview.css（用 data 屬性 guard,避免重覆插入 <link>）。 */
function ensurePreviewCss(): void {
  if (document.head.querySelector(`link[${CSS_LINK_MARKER}]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  link.setAttribute(CSS_LINK_MARKER, '');
  document.head.appendChild(link);
}

let hookRegistered = false;

function buildSanitizer(DOMPurify: {
  sanitize: (html: string, cfg: Record<string, unknown>) => string;
  addHook: (name: string, cb: (node: Element) => void) => void;
}): (html: string) => string {
  // <a> 一律開新分頁並斷開 opener/referrer（只註冊一次 hook）。
  if (!hookRegistered) {
    DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    hookRegistered = true;
  }

  return (html: string): string =>
    DOMPurify.sanitize(html, {
      // 顯式白名單（照 scoringSystem-cf sanitize.ts,去掉 'mention'）。
      ALLOWED_TAGS: [
        'p', 'br', 'span', 'div',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'a', 'img',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'hr', 'input',
      ],
      ALLOWED_ATTR: [
        'href', 'src', 'alt', 'title', 'width', 'height',
        'class', 'id', 'style', 'target', 'rel', 'type', 'checked', 'disabled',
      ],
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      SAFE_FOR_TEMPLATES: true,
    });
}

/** 逾時包裝:超過 LOAD_TIMEOUT_MS 未載完就 reject。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`markdown CDN 載入逾時（${ms}ms）`)), ms),
    ),
  ]);
}

/**
 * 載入 MdPreview + sanitize。成功結果快取;失敗清 cache 以便重試。
 */
export function loadMarkdownRenderer(): Promise<MarkdownRenderer> {
  if (cache) return cache;

  cache = withTimeout(
    (async (): Promise<MarkdownRenderer> => {
      ensurePreviewCss();
      const [mdMod, dpMod] = await Promise.all([
        import(/* @vite-ignore */ MD_URL),
        import(/* @vite-ignore */ DP_URL),
      ]);

      const MdPreview = (mdMod.MdPreview ?? mdMod.default?.MdPreview) as Component | undefined;
      if (!MdPreview) throw new Error('md-editor-v3 未匯出 MdPreview');

      const DOMPurify = (dpMod.default ?? dpMod) as Parameters<typeof buildSanitizer>[0];
      if (typeof DOMPurify?.sanitize !== 'function') throw new Error('DOMPurify 載入失敗');

      return { MdPreview, sanitize: buildSanitizer(DOMPurify) };
    })(),
    LOAD_TIMEOUT_MS,
  ).catch((err) => {
    cache = null; // 清 cache,允許重試
    throw err;
  });

  return cache;
}
