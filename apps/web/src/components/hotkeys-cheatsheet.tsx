import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const SECTIONS: { title: string; items: { combo: string; desc: string }[] }[] = [
  {
    title: '全域',
    items: [
      { combo: '⌘K / Ctrl K', desc: '開啟指令面板' },
      { combo: '/', desc: '聚焦搜尋' },
      { combo: '?', desc: '顯示本說明' },
      { combo: 'Esc', desc: '關閉對話框 / 清除搜尋' },
    ],
  },
  {
    title: '快速新增',
    items: [
      { combo: 'N', desc: '新增支出' },
      { combo: '⇧N', desc: '新增收入' },
    ],
  },
  {
    title: '跳頁 (先按 G)',
    items: [
      { combo: 'G D', desc: '首頁' },
      { combo: 'G X', desc: '需要處理' },
      { combo: 'G L', desc: '記帳' },
      { combo: 'G H', desc: '共同帳本' },
      { combo: 'G I', desc: '投資' },
      { combo: 'G F', desc: '匯率' },
      { combo: 'G T', desc: '出遊' },
      { combo: 'G S', desc: '設定' },
    ],
  },
  {
    title: '列表（DataTable）',
    items: [
      { combo: 'Tab / ↑↓', desc: '瀏覽 filter / pagination' },
      { combo: '清除按鈕', desc: '一鍵清所有 filter + 搜尋' },
      { combo: 'URL query', desc: '篩選狀態會同步寫入網址，可書籤' },
    ],
  },
];

export function HotkeysCheatsheet({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>鍵盤快捷鍵</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {SECTIONS.map((s) => (
            <div key={s.title}>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.title}</h4>
              <ul className="divide-y rounded-md border">
                {s.items.map((it) => (
                  <li key={it.combo} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{it.desc}</span>
                    <kbd className="rounded-md border bg-muted px-2 py-0.5 font-mono text-xs">{it.combo}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
