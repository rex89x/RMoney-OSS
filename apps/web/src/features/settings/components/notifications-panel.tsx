import { useEffect, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { Bell, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { callAppsScript } from '@/lib/apps-script';
import type { NotificationKey, NotificationPrefs } from '@/types/global';

interface NotifyDef {
  key: NotificationKey;
  title: string;
  desc: string;
  testKind?: string; // 對應 Apps Script ?action=notify&kind=
}

const NOTIFICATIONS: NotifyDef[] = [
  { key: 'ledgerDaily', title: '每日記帳彙整', desc: '21:00 — 昨日收支、TOP 類別、月累計 vs 預算', testKind: 'ledgerDaily' },
  { key: 'weeklyReview', title: '每週回顧', desc: '週日 20:00 — 本週支出 vs 上週、TOP 類別、需要處理事項數量與連結', testKind: 'weeklyReview' },
  { key: 'einvoiceSync', title: '電子發票同步', desc: '每日 01:00 — 財政部載具發票自動匯入摘要（需設定 EINVOICE_* Script Properties）', testKind: 'einvoiceSync' },
  { key: 'ledgerMonthly', title: '每月記帳彙整', desc: '每月 1 號 — 上月總覽、與前月比較', testKind: 'ledgerMonthly' },
  { key: 'budgetWarn', title: '預算超標警告', desc: '某類別 ≥ 80% / 100% 預算時提醒', testKind: 'budgetWarn' },
  { key: 'loansReminder', title: '代墊 / 借貸提醒', desc: '每日 21:00 — 整理未結清的代墊或欠款', testKind: 'loansReminder' },
  { key: 'payoutGroupReminder', title: '墊付團催繳提醒', desc: '每日 21:00 — 列出未收齊的下午茶 / 揪團墊付明細', testKind: 'payoutGroupReminder' },
  { key: 'creditCardDue', title: '信用卡帳單到期', desc: '每日 09:00 — 啟用提醒的卡片若繳款日當天/逾期未標記已繳，持續推播', testKind: 'creditCardDue' },
  { key: 'loanDue', title: '貸款繳款提醒', desc: '每日 09:00 — 信貸 / 車貸 / 房貸 nextDueDate 在 7 天內或已逾期就推播', testKind: 'loanDue' },
  { key: 'insuranceDue', title: '保單提醒', desc: '每日 09:00 — 保費 14 天內到期 / 已逾期未繳，或保單 30 天內滿期', testKind: 'insuranceDue' },
  { key: 'monthlyForecast', title: '月底結餘預測', desc: '每日 12:30 — 預估月底結餘 / 是否會超支', testKind: 'monthlyForecast' },
  { key: 'categoryAnomaly', title: '類別花費異常', desc: '每日 12:30 — 本月某類別 vs 過去 6 個月中位數明顯偏高', testKind: 'categoryAnomaly' },
  { key: 'scheduledPaymentDue', title: '排程支出到期', desc: '每日 12:30 — 保險 / 稅金 / 計畫支出，依 remindBeforeDays 提早通知', testKind: 'scheduledPaymentDue' },
  { key: 'subscriptionsDigest', title: '訂閱費月度健檢', desc: '每月 1 號 09:30 — 月平均合計 + Top 5 訂閱', testKind: 'subscriptionsDigest' },
  { key: 'fixedExpensesMonthly', title: '每月固定支出健檢', desc: '每月 1 號 09:30 — 訂閱 + 週期 + 排程攤平合計', testKind: 'fixedExpensesMonthly' },
  { key: 'savingsGoalProgress', title: '儲蓄目標進度', desc: '每月 1 號 09:30 — 各目標進度條', testKind: 'savingsGoalProgress' },
  { key: 'investmentPlanProgress', title: '投資計畫追蹤', desc: '每月 1 號 09:30 — 投資目標進度、缺口與月投入建議', testKind: 'investmentPlanProgress' },
  { key: 'financialHealthDigest', title: '每月理財健檢', desc: '每月 15 號 09:30 — 儲蓄率、預備金、退休規劃、配置偏差與待辦', testKind: 'financialHealthDigest' },
  { key: 'tripRecap', title: '出遊回顧', desc: '每月 1 號 09:30 — 過去 N 年同月份去過哪裡', testKind: 'tripRecap' },
  { key: 'weeklyBackup', title: '每日備份', desc: '每日 01:00 — 主要資料表 export 到 Drive、保留 30 天（需設 BACKUP_FOLDER_ID）', testKind: 'weeklyBackup' },
  { key: 'recurringRun', title: '週期性入帳通知', desc: 'recurring tx 自動產生時通知', testKind: 'recurringRun' },
  { key: 'dividendCalendar', title: '除權息日曆', desc: '每日 18:00 — 持倉標的 7 天內除息，附預估現金股利與二代健保', testKind: 'dividendCalendar' },
  { key: 'taxSeason', title: '報稅季整理', desc: '4/1、5/1 — 去年台股股利抵減 / 分離課稅、二代健保、海外所得門檻', testKind: 'taxSeason' },
  { key: 'marketDaily', title: '市場日報', desc: '09:00 — 持倉、今日漲跌、匯率變動', testKind: 'marketDaily' },
  { key: 'fxDaily', title: '匯率日報', desc: '21:00 — 更新最終匯率後推播各幣別對報價與漲跌', testKind: 'fxDaily' },
  { key: 'swingSignals', title: '短波段紙上實驗', desc: '盤後掃描 — 繁中候選、進出場風險與紙上部位規劃' },
  { key: 'stockRadar', title: '股市雷達盤前建議', desc: '台股 08:00、美股收到 Claude 輿情時（最晚 21:00）— 減碼／出場／加碼／買進候選', testKind: 'stockRadar' },
  { key: 'taifex', title: '台指期虛擬交易', desc: '每日 18:00 訊號、虛擬成交、停損、熔斷；08:00 盤前否決', testKind: 'taifex' },
  { key: 'alertHit', title: '股價/匯率警報', desc: '已設定警報穿越門檻時' },
  { key: 'tripDaily', title: '出遊行程日報', desc: '08:00 — 進行中行程的當日 itinerary', testKind: 'tripDaily' },
  { key: 'tripCountdown', title: '出遊倒數提醒', desc: '出發前 7/3/1 天', testKind: 'tripCountdown' },
  { key: 'flightDeals', title: '機票價格提醒', desc: '依各航線排程 — 達理想價、跌幅達門檻，或設定為每次掃描回報目前票價' },
  { key: 'aiBudget', title: 'Claude API 額度', desc: '本期估算用量達警示門檻或額度上限時通知' },
  { key: 'errors', title: '錯誤通知', desc: '排程任務 throw 時通知（建議常開）' },
];

export function NotificationsPanel() {
  const { user, profile } = useAuth();
  const [prefs, setPrefs] = useState<NotificationPrefs>({});
  const [savingKey, setSavingKey] = useState<NotificationKey | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);

  useEffect(() => {
    setPrefs(profile?.preferences?.notifications ?? {});
  }, [profile]);

  async function toggle(k: NotificationKey, v: boolean) {
    if (!user) return;
    setSavingKey(k);
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        'preferences.notifications': next,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '儲存失敗');
      setPrefs(prefs);
    } finally {
      setSavingKey(null);
    }
  }

  async function runTest(kind: string) {
    setTestingKey(kind);
    try {
      const resp = await callAppsScript<{ skipped?: boolean; chatId?: string }>('notify', { kind });
      if (resp.skipped) toast.info('該通知目前關閉，或無資料可發');
      else toast.success(`已發送${resp.chatId ? ` → chat ${resp.chatId}` : ''}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '測試失敗');
    } finally {
      setTestingKey(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4" /> Telegram 通知
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          全域開關由 Apps Script Script Property <code>TG_NOTIFY_ENABLED</code> 控制；個別開關存在你的 user doc。開關同時決定是否寫入 App 內通知中心（鈴鐺），保留 60 天。
        </p>
        <ul className="divide-y rounded-xl border">
          {NOTIFICATIONS.map((n) => {
            const enabled = prefs[n.key] !== false;
            return (
              <li key={n.key} className="flex items-center gap-3 p-3">
                <div className="flex-1 min-w-0">
                  <Label className="text-sm font-medium">{n.title}</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{n.desc}</p>
                </div>
                {n.testKind ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void runTest(n.testKind!)}
                    disabled={testingKey === n.testKind}
                  >
                    <Send className="size-4" />
                    <span className="hidden sm:inline">測試</span>
                  </Button>
                ) : null}
                <Switch
                  checked={enabled}
                  disabled={savingKey === n.key}
                  onCheckedChange={(v) => void toggle(n.key, v)}
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
