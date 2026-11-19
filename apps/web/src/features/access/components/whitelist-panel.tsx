import { useCallback, useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { Trash2, Mail, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { db } from '@/lib/firebase';
import { useConfirm } from '@/components/ui/confirm';
import { writeWhitelistHashes } from '../whitelist-hashes';

interface WhitelistPanelProps {
  /** 'allowedEmails'（完整登入，角色 member / owner）或 'guestEmails'（viewer：只看分享的旅程） */
  docId: 'allowedEmails' | 'guestEmails';
}

const META = {
  allowedEmails: {
    title: '登入白名單',
    icon: Mail,
    hint: '列表內的 Google 帳號可以登入。新帳號預設角色 member：只看得到共同帳本、分享的旅程與設定；要看投資 / 個人記帳需在下方升成 owner。',
    removeText: '將無法再登入此 app。已建立的資料不會刪除。',
  },
  guestEmails: {
    title: 'Viewer 名單（只看分享的旅程）',
    icon: Eye,
    hint: '只能看被分享的旅程，不能記帳、不能進共同帳本。從旅程「分享」邀請的人會自動加進來。',
    removeText: '將無法再看任何旅程。',
  },
} as const;

/** 讀寫 config/{docId}.emails（admin 才有寫入權限）；每次改動同步 config/{docId}Hashes 給登入檢查用 */
export function WhitelistPanel({ docId }: WhitelistPanelProps) {
  const meta = META[docId];
  const Icon = meta.icon;
  const confirmDialog = useConfirm();
  const [emails, setEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDoc(doc(db, 'config', docId));
      const data = snap.data() as { emails?: string[] } | undefined;
      setEmails(data?.emails ?? []);
    } catch (err) {
      console.error('[whitelist load]', err);
      toast.error(err instanceof Error ? err.message : '讀取失敗');
    } finally {
      setLoading(false);
    }
  }, [docId]);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    const e = newEmail.trim().toLowerCase();
    if (!e || !e.includes('@')) { toast.error('請輸入有效 email'); return; }
    if (emails.some((x) => x.toLowerCase() === e)) { toast.info('已存在'); return; }
    const next = [...emails, e];
    try {
      await setDoc(doc(db, 'config', docId), { emails: next }, { merge: true });
      await writeWhitelistHashes(docId, next);
      setEmails(next);
      setNewEmail('');
      toast.success('已加入');
    } catch (err) {
      console.error('[whitelist add]', err);
      toast.error(err instanceof Error ? err.message : '加入失敗');
    }
  }

  async function remove(e: string) {
    const ok = await confirmDialog({ title: `移除 ${e}`, description: meta.removeText, confirmText: '移除' });
    if (!ok) return;
    const next = emails.filter((x) => x !== e);
    try {
      await setDoc(doc(db, 'config', docId), { emails: next }, { merge: true });
      await writeWhitelistHashes(docId, next);
      setEmails(next);
      toast.success('已移除');
    } catch (err) {
      console.error('[whitelist remove]', err);
      toast.error(err instanceof Error ? err.message : '移除失敗');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4" /> {meta.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{meta.hint}</p>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="someone@gmail.com" />
          <Button type="submit" disabled={!newEmail.trim()}>加入</Button>
        </form>
        {loading ? <p className="text-sm text-muted-foreground">載入中…</p> : emails.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚無資料</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {emails.map((e) => (
              <li key={e} className="flex items-center gap-2 p-2 text-sm">
                <span className="flex-1 truncate">{e}</span>
                <Button size="icon-sm" variant="ghost" onClick={() => void remove(e)} aria-label="移除"><Trash2 className="size-4" /></Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
