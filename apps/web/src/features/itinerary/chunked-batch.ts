import { writeBatch, type WriteBatch } from 'firebase/firestore';
import { db } from '@/lib/firebase';

/** Firestore 單一 batch 上限 500；留點餘裕。 */
const BATCH_LIMIT = 450;

/** 依序累積寫入、每滿 BATCH_LIMIT 筆換一個 batch（行程匯入共用）。 */
export class ChunkedBatch {
  private batches: WriteBatch[] = [writeBatch(db)];
  private count = 0;

  add(op: (batch: WriteBatch) => void): void {
    if (this.count >= BATCH_LIMIT) {
      this.batches.push(writeBatch(db));
      this.count = 0;
    }
    this.count += 1;
    op(this.batches[this.batches.length - 1] as WriteBatch);
  }

  async commit(): Promise<void> {
    for (const batch of this.batches) await batch.commit();
  }
}
