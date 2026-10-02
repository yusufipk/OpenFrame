// Independent readers for exported files: no imports from the serializers under test.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// RFC 4180: quoted cells may hold commas, doubled quotes and line breaks.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface PdfTextItem {
  page: number;
  str: string;
  x: number;
  y: number;
  width: number;
}

// Every non-blank text run with its position in PDF points (y is the baseline, from the
// bottom edge). Text drawn off the page or over other text is still extracted, so
// position is what shows it went wrong.
export async function pdfTextItems(bytes: Uint8Array): Promise<PdfTextItem[]> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const items: PdfTextItem[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    for (const item of content.items) {
      if (!('transform' in item) || !item.str.trim()) continue;
      items.push({
        page: n,
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
      });
    }
  }
  await task.destroy();
  return items;
}

// Text of every page as the PDF viewer would extract it, one string per page.
export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join('\n'));
  }
  await task.destroy();
  return pages;
}
