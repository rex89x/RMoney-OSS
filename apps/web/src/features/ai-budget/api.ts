import { collection, doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { callAppsScript } from '@/lib/apps-script';
import { aiBudgetConfigConverter } from './types';
import type { AiBudgetConfig, AiUsageSummary } from './types';

export const aiBudgetConfigsCol = () =>
  collection(db, 'ai_budget_configs').withConverter(aiBudgetConfigConverter);

export async function getAiBudgetConfig(userId: string): Promise<AiBudgetConfig | null> {
  const snapshot = await getDoc(doc(aiBudgetConfigsCol(), userId));
  return snapshot.exists() ? snapshot.data() : null;
}

export async function saveAiBudgetConfig(config: AiBudgetConfig): Promise<void> {
  await setDoc(doc(aiBudgetConfigsCol(), config.id), config, { merge: true });
}

export async function getAiUsageSummary(cycleOffset: number): Promise<AiUsageSummary> {
  const response = await callAppsScript('getAiUsageSummary', undefined, { cycleOffset });
  return response as unknown as AiUsageSummary;
}
