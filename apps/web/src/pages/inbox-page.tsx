import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InboxList, useAddInboxTodos, useInboxItems } from '@/features/inbox';

export default function InboxPage() {
  const { items, all, dismissed, isLoading } = useInboxItems();
  const addTodos = useAddInboxTodos();
  const [draft, setDraft] = useState('');
  const dismissedItems = all.filter((i) => dismissed[i.id]);

  async function submitTodo() {
    const title = draft.trim();
    if (!title) return;
    await addTodos.mutateAsync([{ title }]);
    setDraft('');
  }

  return (
    <>
      <PageHeader
        title="需要處理"
        description={items.length > 0 ? `${items.length} 項待辦：帳單、代墊、預算、待整理交易` : '帳單、代墊、預算、待整理交易'}
      />
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => { e.preventDefault(); void submitTodo(); }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="新增一項待辦，例：繳停車費、查一下 0050 配息"
          className="h-10"
        />
        <Button type="submit" disabled={!draft.trim() || addTodos.isPending}>
          <Plus className="size-4" /> 加入
        </Button>
      </form>
      {isLoading && items.length === 0 ? (
        <div className="space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <InboxList items={items} dismissedItems={dismissedItems} />
      )}
    </>
  );
}
