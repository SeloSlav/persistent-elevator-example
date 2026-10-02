type CaptureDocument = Pick<Document, 'pointerLockElement' | 'exitPointerLock' | 'addEventListener' | 'removeEventListener'>;
type CaptureCanvas = Pick<HTMLCanvasElement, 'requestPointerLock' | 'focus'> & { ownerDocument: CaptureDocument };

/** Native capture only, as in Mammoth. A failed request never enables gameplay. */
export class PointerCapture {
  private wanted = false;
  private attempt = 0;
  pending = false;
  error = '';

  constructor(private canvas: CaptureCanvas, private changed: (locked: boolean) => void) {
    canvas.ownerDocument.addEventListener('pointerlockchange', this.onChange);
    canvas.ownerDocument.addEventListener('pointerlockerror', this.onError);
  }

  private get ownsPointer() { return Object.is(this.canvas.ownerDocument.pointerLockElement, this.canvas); }
  get locked() { return this.wanted && this.ownsPointer; }

  request() {
    if (this.locked || this.pending) return;
    this.wanted = true;
    this.pending = true;
    this.error = '';
    const attempt = ++this.attempt;
    // Stay in the trusted click event. Do not await a join, frame, or fullscreen.
    try {
      this.canvas.focus({ preventScroll: true });
      const result = this.canvas.requestPointerLock();
      if (result && typeof result.catch === 'function') {
        void result.catch(() => {
          if (attempt === this.attempt && this.wanted && !this.locked) this.fail();
        });
      }
    } catch { if (attempt === this.attempt) this.fail(); }
  }

  release() {
    this.wanted = false;
    this.pending = false;
    this.attempt++;
    if (this.ownsPointer) void this.canvas.ownerDocument.exitPointerLock();
    this.changed(false);
  }

  dispose() {
    this.release();
    this.canvas.ownerDocument.removeEventListener('pointerlockchange', this.onChange);
    this.canvas.ownerDocument.removeEventListener('pointerlockerror', this.onError);
  }

  private fail() {
    this.wanted = false;
    this.pending = false;
    this.error = 'Mouse capture was blocked. Open this game in a desktop browser for continuous first-person look.';
    this.changed(false);
  }

  private onError = () => { if (this.wanted && !this.locked) this.fail(); };
  private onChange = () => {
    this.pending = false;
    if (this.ownsPointer && !this.wanted) {
      void this.canvas.ownerDocument.exitPointerLock();
      this.changed(false);
      return;
    }
    if (!this.ownsPointer) { this.wanted = false; this.attempt++; }
    this.changed(this.locked);
  };
}
