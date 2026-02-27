import { GRATONITE_EPOCH } from '@gratonite/types';

/**
 * Server-side snowflake generator.
 * Returns string to avoid JS Number precision loss on 64-bit IDs.
 * Thread-safe via closure (single worker assumption for now).
 * When scaling to multiple workers, pass unique workerId/processId.
 */

let sequence = 0;
let lastTimestamp = -1n;

const WORKER_ID = BigInt(process.env['WORKER_ID'] ?? 1) & 0x1fn;
const PROCESS_ID = BigInt(process.env['PROCESS_ID'] ?? 1) & 0x1fn;

/** Generate a snowflake ID as a string (safe for JSON + DB with bigint mode:'string') */
export function generateId(): string {
  let timestamp = BigInt(Date.now()) - GRATONITE_EPOCH;

  if (timestamp === lastTimestamp) {
    sequence = (sequence + 1) & 0xfff;
    if (sequence === 0) {
      // Sequence exhausted for this ms — wait for next ms
      while (timestamp <= lastTimestamp) {
        timestamp = BigInt(Date.now()) - GRATONITE_EPOCH;
      }
    }
  } else {
    sequence = 0;
  }

  lastTimestamp = timestamp;

  const snowflake =
    (timestamp << 22n) |
    (WORKER_ID << 17n) |
    (PROCESS_ID << 12n) |
    BigInt(sequence);

  return snowflake.toString();
}
