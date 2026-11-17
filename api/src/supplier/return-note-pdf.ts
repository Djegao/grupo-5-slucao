import type { KitReturnNote } from './kit-note.js';

// #57: o PDF da nota de devolução emitida, anexo do e-mail ao fornecedor junto do JSON (#2, história #155/#156).
// #57: função pura, sem dependência: um PDF 1.4, Helvetica em WinAnsi, A4, que desenha a nota no formato do kit (a mesma
// #57: `KitReturnNote` do JSON, então os valores batem). É uma representação da nota emulada, não um DANFE.
// #57: o PDF sai como texto só de ASCII (o que não é ASCII vai em octal do WinAnsi), um byte por caractere, que é o que o anexo
// #57: (`MailAttachment.content`, string) e a resposta HTTP levam. Ideia de PR #40, adaptada ao modelo da main.

type Text = readonly [x: number, y: number, size: number, text: string];
type Page = Text[];

const TOP = 800;
const BOTTOM = 60;
const LEFT = 50;
const DESCRIPTION_WIDTH = 38; // #57: caracteres da coluna Descrição, a 9 pt, antes de quebrar a linha
const LINE = 14;

const reais = (value: number): string => `R$ ${value.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const dayMonthYear = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** #57: texto de PDF: escapa `\`, `(` e `)` e leva cada caractere fora do ASCII para o octal do WinAnsi (Latin-1). */
function pdfString(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += ch;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return `(${out})`;
}

/** #57: quebra o texto em linhas de até `width` caracteres, nos espaços; uma palavra maior que a linha é partida. Nada se perde. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    let rest = word;
    while (rest.length > width) {
      if (current !== '') lines.push(current);
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
      current = '';
    }
    if (current === '') current = rest;
    else if (current.length + 1 + rest.length <= width) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

/** #57: as páginas: o cabeçalho da nota, os itens (passam de página sem perder nenhum) e o total. */
function layout(note: KitReturnNote): Page[] {
  const pages: Page[] = [[]];
  let y = TOP;
  const page = (): Page => pages[pages.length - 1] as Page;
  const add = (x: number, size: number, text: string): void => {
    page().push([x, y, size, text]);
  };
  const down = (amount: number): void => {
    y -= amount;
  };

  add(LEFT, 16, `Nota de devolução ${note.nota_id}`);
  down(18);
  add(LEFT, 9, 'Emissão emulada (demonstração) · sem valor fiscal');
  down(26);
  add(LEFT, 10, `Número ${note.numero} · série ${note.serie} · emitida em ${dayMonthYear(note.data_emissao)}`);
  down(LINE);
  add(LEFT, 10, `Chave de acesso: ${note.chave}`);
  down(LINE);
  add(LEFT, 10, `Emitente: ${note.emitente.nome} · destino ${note.emitente.destino}`);
  down(LINE);
  add(LEFT, 10, `Fornecedor: ${note.fornecedor_id}`);
  down(LINE);
  add(LEFT, 10, `Nota referenciada: ${note.nota_referenciada}`);
  down(LINE);
  add(LEFT, 10, `Natureza: ${note.natureza}`);
  down(28);

  const header = (): void => {
    for (const [x, label] of [[LEFT, 'Código'], [130, 'Descrição'], [360, 'Qtd.'], [420, 'Preço unit.'], [500, 'Valor']] as const) add(x, 10, label);
    down(16);
  };
  const nextPage = (): void => {
    pages.push([]);
    y = TOP;
    header();
  };

  header();
  for (const item of note.itens) {
    const description = wrap(item.descricao, DESCRIPTION_WIDTH);
    if (y - (description.length - 1) * LINE < BOTTOM) nextPage();
    add(LEFT, 9, item.codigo_fornecedor);
    add(360, 9, `${item.quantidade} ${item.unidade}`);
    add(420, 9, reais(item.preco_unitario));
    add(500, 9, reais(item.valor));
    for (const part of description) {
      add(130, 9, part);
      down(LINE);
    }
  }
  down(12);
  if (y < BOTTOM) nextPage();
  add(420, 11, `Total: ${reais(note.valor_total)}`);
  return pages;
}

const contentOf = (page: Page): string =>
  page.map(([x, y, size, text]) => `BT /F1 ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET`).join('\n');

/** #57: o PDF da nota como texto ASCII (um byte por caractere). Dois objetos por página: a página e o conteúdo dela. */
export function returnNotePdf(note: KitReturnNote): string {
  const pages = layout(note);
  const firstPageObject = 4;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPageObject + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((page, i) => {
    const content = contentOf(page);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPageObject + i * 2 + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
