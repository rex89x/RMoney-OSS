import { useEffect } from 'react';

export interface Hotkey {
  /** "cmd+k" / "ctrl+k" / "n" / "g then l" (空格分隔序列) */
  combo: string;
  description: string;
  handler: (e: KeyboardEvent) => void;
  /** 忽略輸入中的 input / textarea / contenteditable */
  ignoreInputs?: boolean;
}

let globalHotkeys: Hotkey[] = [];
let sequence: string[] = [];
let sequenceTimer: ReturnType<typeof setTimeout> | null = null;
const SEQUENCE_TIMEOUT_MS = 1500;

function normalize(combo: string): string {
  return combo.toLowerCase().replace(/\s+/g, ' ').trim();
}

function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push('cmd');
  if (e.ctrlKey && !e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const key = (e.key || '').toLowerCase();
  if (!['meta', 'control', 'alt', 'shift'].includes(key)) parts.push(key);
  return parts.join('+');
}

function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return false;
}

function handleKey(e: KeyboardEvent) {
  const combo = comboFromEvent(e);
  // 處理 modifier combos（優先）
  const modMatches = globalHotkeys.filter(
    (h) => !h.combo.includes(' ') && normalize(h.combo) === combo,
  );
  for (const h of modMatches) {
    if (h.ignoreInputs !== false && isEditing(e.target)) continue;
    e.preventDefault();
    h.handler(e);
    return;
  }

  // sequence (e.g. "g l"): 僅在無 modifier 時判斷
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
    if (isEditing(e.target)) return;
    const k = e.key.toLowerCase();
    sequence.push(k);
    if (sequenceTimer) clearTimeout(sequenceTimer);
    sequenceTimer = setTimeout(() => { sequence = []; }, SEQUENCE_TIMEOUT_MS);

    // 檢查是否有精確序列命中
    const asStr = sequence.join(' ');
    const seqMatches = globalHotkeys.filter((h) => h.combo.includes(' ') && normalize(h.combo) === asStr);
    if (seqMatches.length > 0) {
      e.preventDefault();
      sequence = [];
      if (sequenceTimer) clearTimeout(sequenceTimer);
      for (const h of seqMatches) h.handler(e);
      return;
    }

    // 若沒有任何 combo 以目前 prefix 開頭，重設
    const hasPrefix = globalHotkeys.some((h) => h.combo.includes(' ') && normalize(h.combo).startsWith(asStr + ' '));
    if (!hasPrefix && seqMatches.length === 0) {
      if (sequence.length >= 3) sequence = [];
    }
  }
}

let listenerAttached = false;
function ensureListener() {
  if (listenerAttached) return;
  listenerAttached = true;
  window.addEventListener('keydown', handleKey);
}

export function useHotkeys(hotkeys: Hotkey[]): void {
  useEffect(() => {
    ensureListener();
    globalHotkeys = globalHotkeys.concat(hotkeys);
    return () => {
      globalHotkeys = globalHotkeys.filter((h) => !hotkeys.includes(h));
    };
  }, [hotkeys]);
}

/** 取得目前註冊的所有 hotkeys（給 cheatsheet 顯示用） */
export function getRegisteredHotkeys(): ReadonlyArray<Pick<Hotkey, 'combo' | 'description'>> {
  return globalHotkeys.map((h) => ({ combo: h.combo, description: h.description }));
}
