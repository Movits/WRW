import { lerCsv, LINHAS_POR_ARQUIVO_MAX } from "@shared/entidades";

/**
 * A planilha da entidade (N1) lida NO APARELHO: CSV ou XLSX. O arquivo nunca
 * sobe ao servidor; só as linhas já mapeadas, em blocos, e o SHA-256 dele
 * (para o relatório e a auditoria).
 *
 * O XLSX é um ZIP de XMLs. Em vez de uma biblioteca nova (a SheetJS do npm
 * parou numa versão com falhas conhecidas), este leitor faz só o que a carga
 * precisa: a primeira aba, as células de texto, número e booleano, os textos
 * compartilhados e o texto em linha. Fórmula vale pelo valor guardado. O
 * descompactar é o DecompressionStream do próprio navegador ("deflate-raw").
 */

export type ErroDaPlanilha = "FORMATO_DESCONHECIDO" | "PLANILHA_ILEGIVEL" | "PLANILHA_VAZIA" | "LINHAS_DEMAIS";
export class PlanilhaIlegivel extends Error {
  constructor(public codigo: ErroDaPlanilha) { super(codigo); }
}

export async function sha256DoArquivo(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Texto do CSV: UTF-8; se não for UTF-8 válido, Windows-1252 (o "Salvar como CSV" do Excel em português). */
export function decodificarCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export async function lerPlanilha(nome: string, bytes: ArrayBuffer): Promise<string[][]> {
  const u8 = new Uint8Array(bytes);
  const ehZip = u8[0] === 0x50 && u8[1] === 0x4b;
  let linhas: string[][];
  if (/\.xlsx$/i.test(nome) || ehZip) {
    if (!ehZip) throw new PlanilhaIlegivel("PLANILHA_ILEGIVEL");
    linhas = await lerXlsx(u8);
  } else if (/\.(csv|txt|tsv)$/i.test(nome)) {
    linhas = lerCsv(decodificarCsv(u8));
  } else throw new PlanilhaIlegivel("FORMATO_DESCONHECIDO");
  if (linhas.length < 2) throw new PlanilhaIlegivel("PLANILHA_VAZIA");
  if (linhas.length - 1 > LINHAS_POR_ARQUIVO_MAX) throw new PlanilhaIlegivel("LINHAS_DEMAIS");
  return linhas;
}

// ─── ZIP ─────────────────────────────────────────────────────────────────────

type Entrada = { nome: string; metodo: number; tamanho: number; inicio: number };

function entradasDoZip(zip: Uint8Array): Map<string, Entrada> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // O fim do diretório central (assinatura 0x06054b50), procurado de trás para a frente.
  let fim = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { fim = i; break; }
  }
  if (fim < 0) throw new PlanilhaIlegivel("PLANILHA_ILEGIVEL");
  const total = dv.getUint16(fim + 10, true);
  let p = dv.getUint32(fim + 16, true);
  const entradas = new Map<string, Entrada>();
  const decodificador = new TextDecoder();
  for (let n = 0; n < total; n += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new PlanilhaIlegivel("PLANILHA_ILEGIVEL");
    const metodo = dv.getUint16(p + 10, true);
    const tamanho = dv.getUint32(p + 20, true);
    const tamNome = dv.getUint16(p + 28, true);
    const tamExtra = dv.getUint16(p + 30, true);
    const tamComentario = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nome = decodificador.decode(zip.subarray(p + 46, p + 46 + tamNome));
    const inicio = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    entradas.set(nome, { nome, metodo, tamanho, inicio });
    p += 46 + tamNome + tamExtra + tamComentario;
  }
  return entradas;
}

async function lerEntrada(zip: Uint8Array, entrada: Entrada): Promise<string> {
  const dados = zip.subarray(entrada.inicio, entrada.inicio + entrada.tamanho);
  if (entrada.metodo === 0) return new TextDecoder().decode(dados);
  if (entrada.metodo !== 8) throw new PlanilhaIlegivel("PLANILHA_ILEGIVEL");
  const fluxo = new ReadableStream<Uint8Array>({
    start(controle) { controle.enqueue(dados.slice()); controle.close(); },
  }).pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const leitor = fluxo.getReader();
  const decodificador = new TextDecoder();
  let texto = "";
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    texto += decodificador.decode(value, { stream: true });
  }
  return texto + decodificador.decode();
}

// ─── XLSX ────────────────────────────────────────────────────────────────────

const xml = (texto: string) => new DOMParser().parseFromString(texto, "application/xml");
const filhos = (no: Element | Document, nome: string) => Array.from(no.getElementsByTagName(nome));

function colunaDaReferencia(ref: string): number {
  const letras = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

async function caminhoDaPrimeiraAba(zip: Uint8Array, entradas: Map<string, Entrada>): Promise<string> {
  const livro = entradas.get("xl/workbook.xml");
  const relacoes = entradas.get("xl/_rels/workbook.xml.rels");
  if (livro && relacoes) {
    const aba = filhos(xml(await lerEntrada(zip, livro)), "sheet")[0];
    const id = aba?.getAttribute("r:id") ?? aba?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const alvo = filhos(xml(await lerEntrada(zip, relacoes)), "Relationship").find(r => r.getAttribute("Id") === id)?.getAttribute("Target");
    if (alvo) {
      const caminho = alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo}`;
      if (entradas.has(caminho)) return caminho;
    }
  }
  const primeira = Array.from(entradas.keys()).filter(n => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0];
  if (!primeira) throw new PlanilhaIlegivel("PLANILHA_ILEGIVEL");
  return primeira;
}

export async function lerXlsx(zip: Uint8Array): Promise<string[][]> {
  const entradas = entradasDoZip(zip);
  const compartilhadas: string[] = [];
  const sst = entradas.get("xl/sharedStrings.xml");
  if (sst) {
    for (const si of filhos(xml(await lerEntrada(zip, sst)), "si")) {
      compartilhadas.push(filhos(si, "t").map(t => t.textContent ?? "").join(""));
    }
  }
  const aba = xml(await lerEntrada(zip, entradas.get(await caminhoDaPrimeiraAba(zip, entradas))!));
  const linhas: string[][] = [];
  for (const row of filhos(aba, "row")) {
    const linha: string[] = [];
    let proxima = 0;
    for (const c of filhos(row, "c")) {
      const ref = c.getAttribute("r");
      const coluna = ref ? colunaDaReferencia(ref) : proxima;
      proxima = coluna + 1;
      const tipo = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
      let valor: string;
      if (tipo === "s") valor = compartilhadas[Number(v)] ?? "";
      else if (tipo === "inlineStr") valor = filhos(c, "t").map(t => t.textContent ?? "").join("");
      else if (tipo === "b") valor = v === "1" ? "1" : "0";
      else valor = v;
      linha[coluna] = valor;
    }
    const cheia = Array.from({ length: linha.length }, (_, i) => linha[i] ?? "");
    if (cheia.some(v => v.trim())) linhas.push(cheia);
  }
  return linhas;
}
