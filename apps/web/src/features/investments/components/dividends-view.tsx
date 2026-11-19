import { useMemo, useState } from 'react';
import { Plus, Trash2, Coins } from 'lucide-react';
import { toast } from 'sonner';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { useConfirm } from '@/components/ui/confirm';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { dateInputToTWDate, formatDateInput, formatTW, nowTW, startOfTWDay } from '@/lib/tz';
import { useFxRate } from '@/features/ledger/hooks';
import { useAddDividend, useDeleteDividend, useDividends, useStocks } from '../hooks';
import type { Dividend } from '../types';
import { DividendCalendarCard, DividendTaxCard } from './dividend-calendar-card';

type FormState = {
  symbol: string;
  payDate: Date;
  amountPerShare: string;
  shares: string;
  currency: 'TWD' | 'USD';
  note: string;
};

export function DividendsView() {
  const { data: dividends = [] } = useDividends();
  const { data: stocks = [] } = useStocks();
  const add = useAddDividend();
  const del = useDeleteDividend();
  const confirm = useConfirm();
  const { data: usdRate = 31 } = useFxRate('USD');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>({
    symbol: '', payDate: new Date(), amountPerShare: '', shares: '', currency: 'TWD', note: '',
  });

  function reset() {
    setForm({ symbol: '', payDate: new Date(), amountPerShare: '', shares: '', currency: 'TWD', note: '' });
  }

  async function submit() {
    if (!form.symbol.trim() || !form.amountPerShare || !form.shares) { toast.error('請完整填寫'); return; }
    const aps = Number(form.amountPerShare);
    const sh = Number(form.shares);
    if (!aps || !sh) return;
    const fx = form.currency === 'USD' ? usdRate : 1;
    const stock = stocks.find((s) => s.symbol === form.symbol.trim());
    await add.mutateAsync({
      symbol: form.symbol.trim(),
      market: stock?.market ?? (form.currency === 'USD' ? 'US' : 'TW'),
      payDate: dateInputToTWDate(formatDateInput(form.payDate)) ?? form.payDate,
      amountPerShare: aps,
      shares: sh,
      currency: form.currency,
      fxRate: fx,
      amountTWD: aps * sh * fx,
      note: form.note.trim() || null,
    });
    toast.success('已新增股息');
    setOpen(false);
    reset();
  }

  async function handleDelete(d: Dividend) {
    const ok = await confirm({ title: '刪除股息紀錄？', description: `${d.symbol} ${formatTW(d.payDate, 'yyyy/MM/dd')}`, confirmText: '刪除' });
    if (!ok) return;
    await del.mutateAsync(d.id);
    toast.success('已刪除');
  }

  // 圖表：本年度月度股息
  const chartData = useMemo(() => {
    const year = nowTW().getFullYear();
    const months: Array<{ month: string; amount: number }> = [];
    for (let m = 0; m < 12; m++) {
      months.push({ month: `${m + 1}月`, amount: 0 });
    }
    for (const d of dividends) {
      if (Number(formatTW(d.payDate, 'yyyy')) !== year) continue;
      months[Number(formatTW(d.payDate, 'M')) - 1]!.amount += d.amountTWD; // 非空：索引已做邊界 / 長度檢查
    }
    return months;
  }, [dividends]);

  const yearTotal = chartData.reduce((s, m) => s + m.amount, 0);
  const ttmTotal = useMemo(() => {
    const cutoff = startOfTWDay();
    cutoff.setUTCDate(cutoff.getUTCDate() - 365);
    return dividends.filter((d) => d.payDate.getTime() >= cutoff.getTime()).reduce((s, d) => s + d.amountTWD, 0);
  }, [dividends]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Card><CardContent className="p-3">
          <div className="text-[11px] text-muted-foreground">{nowTW().getFullYear()} 年累計</div>
          <div className="text-xl font-semibold tabular-nums">{formatCurrency(yearTotal)}</div>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <div className="text-[11px] text-muted-foreground">過去 12 個月</div>
          <div className="text-xl font-semibold tabular-nums">{formatCurrency(ttmTotal)}</div>
        </CardContent></Card>
      </div>

      <DividendCalendarCard />

      <DividendTaxCard />

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">月度股息（本年）</CardTitle></CardHeader>
        <CardContent className="h-[200px] px-0 pr-4 sm:px-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="month" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} width={48} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="amount" fill="#10b981" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base"><Coins className="size-4" /> 股息紀錄</CardTitle>
          <Button size="sm" variant="outline" onClick={() => { reset(); setOpen(true); }}><Plus className="size-4" /> 新增</Button>
        </CardHeader>
        <CardContent>
          {dividends.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚無股息紀錄</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {dividends.slice(0, 50).map((d) => (
                <li key={d.id} className="flex items-center gap-3 p-3">
                  <Coins className="size-4 shrink-0 text-emerald-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium">
                      <span>{d.symbol}</span>
                      <Badge variant="outline" className="text-[10px]">{d.market}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatTW(d.payDate, 'yyyy/MM/dd')} · {d.shares} × {d.amountPerShare} {d.currency}
                    </div>
                  </div>
                  <div className="text-right text-sm tabular-nums">{formatCurrency(d.amountTWD)}</div>
                  <Button size="icon-sm" variant="ghost" onClick={() => void handleDelete(d)} aria-label="刪除">
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title="新增股息"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>取消</Button>
            <Button className="flex-1" onClick={() => void submit()} disabled={add.isPending}>儲存</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>代號</Label>
              <Input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="例：2330 / VOO" autoFocus />
            </div>
            <div><Label>幣別</Label>
              <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v as 'TWD' | 'USD' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="TWD">TWD</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>每股股息</Label>
              <Input type="number" inputMode="decimal" step="0.01" value={form.amountPerShare} onChange={(e) => setForm({ ...form, amountPerShare: e.target.value })} placeholder="2.5" />
            </div>
            <div><Label>持股數</Label>
              <Input type="number" inputMode="decimal" value={form.shares} onChange={(e) => setForm({ ...form, shares: e.target.value })} placeholder="100" />
            </div>
          </div>
          <div><Label>除息日</Label>
            <DatePicker value={form.payDate} onChange={(d) => d && setForm({ ...form, payDate: d })} clearable={false} />
          </div>
          <div><Label>備註</Label>
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
        </div>
      </ResponsiveDialog>
    </div>
  );
}
