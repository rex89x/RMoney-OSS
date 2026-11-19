import { useState } from 'react';
import { Plus, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { resolveIcon, CATEGORY_ICON_NAMES } from '@/lib/icons';
import { useArchiveCategory, useCategories, useUpsertCategory } from '../hooks';

export function CategoryManager() {
  const { data: categories = [] } = useCategories();
  const upsert = useUpsertCategory();
  const archive = useArchiveCategory();
  const [draftKey, setDraftKey] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftType, setDraftType] = useState<'expense' | 'income'>('expense');
  const [draftIcon, setDraftIcon] = useState('MoreHorizontal');
  const [draftColor, setDraftColor] = useState('#6B7280');

  async function handleAdd() {
    if (!draftKey || !draftName) return;
    await upsert.mutateAsync({
      key: draftKey,
      name: draftName,
      type: draftType,
      icon: draftIcon,
      color: draftColor,
      order: categories.length + 1,
    });
    setDraftKey('');
    setDraftName('');
  }

  const expense = categories.filter((c) => c.type === 'expense');
  const income = categories.filter((c) => c.type === 'income');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>新增類別</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-6">
          <div className="md:col-span-2">
            <Label>Key (唯一)</Label>
            <Input value={draftKey} onChange={(e) => setDraftKey(e.target.value)} placeholder="e.g. subscription" />
          </div>
          <div className="md:col-span-2">
            <Label>名稱</Label>
            <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          </div>
          <div>
            <Label>類型</Label>
            <Select value={draftType} onValueChange={(v) => setDraftType(v as 'expense' | 'income')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="expense">支出</SelectItem>
                <SelectItem value="income">收入</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Icon</Label>
            <Select value={draftIcon} onValueChange={setDraftIcon}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORY_ICON_NAMES.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-5">
            <Label>顏色</Label>
            <Input type="color" value={draftColor} onChange={(e) => setDraftColor(e.target.value)} className="h-10 w-20 p-1" />
          </div>
          <div className="flex items-end">
            <Button onClick={handleAdd} className="w-full" disabled={upsert.isPending}>
              <Plus className="size-4" /> 新增
            </Button>
          </div>
        </CardContent>
      </Card>

      <CategoryGrid title="支出類別" categories={expense} onArchive={(id) => void archive.mutateAsync(id)} />
      <CategoryGrid title="收入類別" categories={income} onArchive={(id) => void archive.mutateAsync(id)} />
    </div>
  );
}

function CategoryGrid({
  title,
  categories,
  onArchive,
}: {
  title: string;
  categories: Array<{ id: string; key: string; name: string; icon: string; color: string }>;
  onArchive: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {categories.map((c) => {
          const Icon = resolveIcon(c.icon);
          return (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-md border p-3"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-5" style={{ color: c.color }} />
                <span className="text-sm">{c.name}</span>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => onArchive(c.id)}
                aria-label="Archive"
              >
                <Archive className="size-4" />
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
