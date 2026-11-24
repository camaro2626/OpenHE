/**
 * Request/response transport over one WebHID collection.
 *
 * Drivers depend only on `ReportTransport`, so tests can hand them a fake
 * board and the same driver code can later run over another backend.
 */

export interface ReportTransport {
  /**
   * Send one output report and resolve with the next input report (the next
   * one `accept` takes, when given; others are dropped).
   */
  exchange(
    report: Uint8Array,
    timeoutMs?: number,
    accept?: (reply: Uint8Array) => boolean
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** The parts of the WebHID `HIDDevice` this module uses. */
export interface HidDeviceLike {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections?: ReadonlyArray<{ usagePage?: number; usage?: number }>;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(
    type: 'inputreport',
    listener: (event: { reportId: number; data: DataView }) => void
  ): void;
  removeEventListener(
    type: 'inputreport',
    listener: (event: { reportId: number; data: DataView }) => void
  ): void;
}

/**
 * Input-report transport: one request in flight at a time, replies matched in
 * order. Fits protocols where every output report gets exactly one input
 * report (libhmk raw HID).
 */
export class InputReportTransport implements ReportTransport {
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: ((data: Uint8Array) => void) | null = null;
  private accept: ((data: Uint8Array) => boolean) | null = null;
  private readonly onReport = (event: { reportId: number; data: DataView }) => {
    if (event.reportId !== this.reportId) return;
    const data = new Uint8Array(
      event.data.buffer,
      event.data.byteOffset,
      event.data.byteLength
    ).slice();
    if (this.accept && !this.accept(data)) return;
    const w = this.waiter;
    this.waiter = null;
    w?.(data);
  };

  constructor(
    private readonly device: HidDeviceLike,
    private readonly reportId = 0
  ) {
    device.addEventListener('inputreport', this.onReport);
  }

  exchange(
    report: Uint8Array,
    timeoutMs = 1000,
    accept?: (reply: Uint8Array) => boolean
  ): Promise<Uint8Array> {
    const run = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          this.accept = null;
          reject(new Error('Keyboard did not answer'));
        }, timeoutMs);
        this.accept = accept ?? null;
        this.waiter = data => {
          clearTimeout(timer);
          this.accept = null;
          resolve(data);
        };
        this.device.sendReport(this.reportId, report as BufferSource).catch(err => {
          clearTimeout(timer);
          this.waiter = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.device.removeEventListener('inputreport', this.onReport);
    if (this.device.opened) await this.device.close();
  }
}

export function hasCollection(device: HidDeviceLike, usagePage: number, usage?: number): boolean {
  return (device.collections ?? []).some(
    c => c.usagePage === usagePage && (usage === undefined || c.usage === usage)
  );
}
