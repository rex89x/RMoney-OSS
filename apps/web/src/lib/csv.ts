import Papa from 'papaparse';

export interface CsvResult<T> {
  rows: T[];
  errors: string[];
}

export function parseCsv<T>(text: string): CsvResult<T> {
  const res = Papa.parse<T>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  const errors = (res.errors ?? []).map((e) => `row ${e.row}: ${e.message}`);
  return { rows: res.data as T[], errors };
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns?: (keyof T)[]): string {
  if (rows.length === 0) return '';
  const fields = (columns ?? Object.keys(rows[0] as object)).map(String);
  return Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => (r as Record<string, unknown>)[f] ?? '')) });
}

export function downloadText(name: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file, 'utf-8');
  });
}
