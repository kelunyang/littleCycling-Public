import { ref, onUnmounted, type Ref } from 'vue';

export interface DocumentPiPReturn {
  isSupported: Ref<boolean>;
  isActive: Ref<boolean>;
  pipWindow: Ref<Window | null>;
  pipContainer: Ref<HTMLElement | null>;
  open(options?: { width?: number; height?: number }): Promise<void>;
  close(): void;
}

export function useDocumentPiP(): DocumentPiPReturn {
  const isSupported = ref('documentPictureInPicture' in window);
  const isActive = ref(false);
  const pipWindow = ref<Window | null>(null);
  const pipContainer = ref<HTMLElement | null>(null);

  function injectStyles(pipWin: Window) {
    const pipDoc = pipWin.document;

    // Copy all stylesheets (handles both Vite dev <style> tags and prod <link> tags)
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      pipDoc.head.appendChild(node.cloneNode(true));
    }

    // Copy Google Fonts link tags
    for (const link of document.head.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]')) {
      pipDoc.head.appendChild(link.cloneNode(true));
    }

    // Set dark mode class (Element Plus dark theme)
    pipDoc.documentElement.classList.add('dark');

    // Base body styles
    pipDoc.body.style.margin = '0';
    pipDoc.body.style.background = '#050810';
    pipDoc.body.style.fontFamily = 'var(--font-body)';
    pipDoc.body.style.color = 'var(--hud-text)';
    pipDoc.body.style.overflow = 'hidden';
  }

  async function open(options?: { width?: number; height?: number }) {
    if (!isSupported.value || isActive.value) return;

    const width = options?.width ?? 800;
    const height = options?.height ?? 500;

    const win = await window.documentPictureInPicture!.requestWindow({ width, height });
    pipWindow.value = win;

    // Inject styles into PiP document
    injectStyles(win);

    // Create teleport container
    const container = win.document.createElement('div');
    container.id = 'pip-root';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    win.document.body.appendChild(container);
    pipContainer.value = container;

    isActive.value = true;

    // Handle PiP window close
    win.addEventListener('pagehide', () => {
      pipContainer.value = null;
      pipWindow.value = null;
      isActive.value = false;
    });
  }

  function close() {
    if (pipWindow.value) {
      pipWindow.value.close();
      pipContainer.value = null;
      pipWindow.value = null;
      isActive.value = false;
    }
  }

  onUnmounted(() => {
    close();
  });

  return { isSupported, isActive, pipWindow, pipContainer, open, close };
}
