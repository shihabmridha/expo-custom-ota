import type { Logger } from './logger.ts';

type Category = 'usage' | 'device';

/** Two bounded, process-local buckets; diagnostics never depend on the database. */
export class TrackingDiagnostics {
  private readonly buckets = new Map<Category, { lastWarning: number; suppressed: number }>();

  constructor(private readonly logger: Logger) {}

  failure(category: Category, applicationId: string, now = Date.now()): void {
    const bucket = this.buckets.get(category);
    if (bucket && now - bucket.lastWarning < 60_000) {
      bucket.suppressed++;
      return;
    }
    this.buckets.set(category, { lastWarning: now, suppressed: 0 });
    try {
      this.logger.warn('tracking_write_failed', {
        category,
        applicationId,
        suppressedFailures: bucket?.suppressed ?? 0,
      });
    } catch {
      // Even a failed diagnostic sink must not interrupt OTA delivery.
    }
  }
}
