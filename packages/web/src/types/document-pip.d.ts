interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

interface DocumentPictureInPictureEvent extends Event {
  readonly window: Window;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
  // eslint-disable-next-line no-var
  var documentPictureInPicture: DocumentPictureInPicture | undefined;
}

export {};
