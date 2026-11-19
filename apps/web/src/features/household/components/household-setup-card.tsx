import { useState } from 'react';
import { HeartHandshake, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateHousehold } from '../hooks';

/** 尚未建立共同帳本時的引導卡（owner 才會看到） */
export function HouseholdSetupCard() {
  const create = useCreateHousehold();
  const [name, setName] = useState('我們的共同帳');

  async function handleCreate() {
    try {
      await create.mutateAsync(name);
      toast.success('已建立，接著邀請伴侶加入');
    } catch (err) {
      console.error('[createHousehold]', err);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><HeartHandshake className="size-4" /> 建立共同帳本</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>兩人各自記共同支出，系統算出誰該付誰多少，一鍵結算。</li>
          <li>伴侶用自己的 Google 帳號登入，只看得到共同帳本，看不到你的投資與個人帳。</li>
          <li>快速記帳會多一個「共同分攤」開關，日常記帳順手打勾即可。</li>
        </ul>
        <div>
          <Label>名稱</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
        </div>
        <Button onClick={() => void handleCreate()} disabled={create.isPending || !name.trim()}>
          {create.isPending ? <Loader2 className="size-4 animate-spin" /> : null} 建立
        </Button>
      </CardContent>
    </Card>
  );
}
