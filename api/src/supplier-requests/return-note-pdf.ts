// #156/AC-5 O PDF simples da nota de devolução emitida, anexo ao e-mail junto do JSON. Sem dependência: um PDF 1.4
// de uma página, Helvetica em WinAnsi, com o cabeçalho da nota, os itens e o total. É uma representação da nota
// emulada, não um DANFE (a emissão fiscal real está fora da #156).
import type { ReturnNote } from '../domain/index.js';

const reais = (value: number): string =>
  `R$ ${value.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const dayMonthYear = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** #156 Texto de PDF: escapa `\`, `(` e `)` e leva cada caractere fora do ASCII para o octal do WinAnsi (Latin-1). */
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

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** #156 As linhas da página: [x, y, tamanho, texto]. */
function lines(note: ReturnNote): [number, number, number, string][] {
  const out: [number, number, number, string][] = [];
  let y = 790;
  const add = (x: number, size: number, text: string) => out.push([x, y, size, text]);
  add(50, 16, `Nota de devolução ${note.nota_id}`);
  y -= 18;
  add(50, 9, 'Emissão emulada (demonstração) · sem valor fiscal');
  y -= 26;
  add(50, 10, `Número ${note.numero} · série ${note.serie} · emitida em ${dayMonthYear(note.data_emissao)}`);
  y -= 14;
  add(50, 10, `Chave de acesso: ${note.chave}`);
  y -= 14;
  add(50, 10, `Emitente (CNPJ): ${note.emitente} · destino ${note.destino}`);
  y -= 14;
  add(50, 10, `Fornecedor: ${note.fornecedor_id}`);
  y -= 14;
  add(50, 10, `Nota referenciada: ${note.nota_referenciada}`);
  y -= 14;
  add(50, 10, `Natureza: ${note.natureza}`);
  y -= 28;
  for (const [x, label] of [[50, 'Código'], [130, 'Descrição'], [350, 'Qtd.'], [420, 'Preço unit.'], [500, 'Valor']] as const) {
    out.push([x, y, 10, label]);
  }
  y -= 16;
  for (const item of note.itens) {
    if (y < 80) {
      add(50, 9, '(itens continuam no anexo JSON)');
      break;
    }
    out.push([50, y, 9, cut(item.codigo_fornecedor, 14)]);
    out.push([130, y, 9, cut(item.descricao, 40)]);
    out.push([350, y, 9, `${item.quantidade} ${item.unidade}`]);
    out.push([420, y, 9, reais(item.preco_unitario)]);
    out.push([500, y, 9, reais(item.valor)]);
    y -= 14;
  }
  y -= 12;
  add(420, 11, `Total: ${reais(note.valor_total)}`);
  return out;
}

/** #156 O PDF como texto Latin-1 (um byte por caractere). */
export function returnNotePdf(note: ReturnNote): string {
  const content = lines(note)
    .map(([x, y, size, text]) => `BT /F1 ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

/** #156 O PDF em base64, como o anexo do e-mail o leva (o Resend e a caixa mock recebem base64). */
export const returnNotePdfBase64 = (note: ReturnNote): string => btoa(returnNotePdf(note));
