import type { MapaMental } from "@shared/mapa-mental";

/**
 * Baixar o mapa mental em JPEG e PDF (H10b; HN-40 do app de referência da
 * cliente), feito no aparelho, sem biblioteca e sem servidor.
 *
 * - O desenho (desenhoDoMapa) é uma conta pura: a árvore horizontal da tela,
 *   com a raiz à esquerda (à direita no texto da direita para a esquerda), uma
 *   coluna por nível, cada nó centrado nos filhos dele e o texto quebrado na
 *   largura da coluna (por palavra; a palavra longa demais e a escrita sem
 *   espaço, como o chinês e o japonês, por letra).
 * - O JPEG sai de um <canvas> desenhado com as fontes do próprio aparelho:
 *   como o PDF da exportação da reunião (shared/exportar-reuniao.ts), assim o
 *   árabe, o hindi, o chinês e o japonês saem certos sem embutir fonte.
 * - O PDF é uma página do tamanho do desenho, com o mesmo JPEG dentro
 *   (pdfComJpeg): o PDF mínimo, montado byte a byte. O texto do PDF não se
 *   seleciona; quem quer o texto baixa o Markdown.
 */

export type CaixaDoDesenho = { x: number; y: number; largura: number; altura: number; linhas: string[]; nivel: 0 | 1 | 2 | 3 };
export type LigacaoDoDesenho = { de: { x: number; y: number }; para: { x: number; y: number } };
export type DesenhoDoMapa = { largura: number; altura: number; caixas: CaixaDoDesenho[]; ligacoes: LigacaoDoDesenho[] };

/** Mede a largura de um texto no nível dado (o canvas, na tela; um dublê, no teste). */
export type Medir = (texto: string, nivel: 0 | 1 | 2 | 3) => number;

export const MEDIDAS_DO_DESENHO = {
  margem: 32,
  coluna: [200, 220, 220, 200] as const,
  espacoEntreColunas: 48,
  espacoEntreLinhas: 10,
  folgaInterna: 10,
  alturaDaLinha: [20, 19, 18, 16] as const,
  /** O desenho maior que isso fica do tamanho que o navegador aceita num canvas. */
  ladoMaximo: 8000,
};

/** O texto quebrado em linhas que cabem em `largura`. */
export function quebrarTexto(texto: string, largura: number, medir: (t: string) => number): string[] {
  const linhas: string[] = [];
  let atual = "";
  const empurrar = (pedaco: string, separador: string) => {
    const tentativa = atual ? `${atual}${separador}${pedaco}` : pedaco;
    if (medir(tentativa) <= largura) { atual = tentativa; return true; }
    return false;
  };
  for (const palavra of texto.split(/\s+/).filter(Boolean)) {
    if (empurrar(palavra, " ")) continue;
    if (atual) { linhas.push(atual); atual = ""; }
    if (empurrar(palavra, "")) continue;
    // A palavra sozinha não cabe: por letra.
    for (const letra of Array.from(palavra)) {
      if (!empurrar(letra, "")) { if (atual) linhas.push(atual); atual = letra; }
    }
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [""];
}

type No = { texto: string; nivel: 0 | 1 | 2 | 3; filhos: No[] };

/**
 * A árvore desenhada: as caixas (com as linhas de texto) e as ligações. `rtl`
 * espelha o desenho: a raiz fica à direita.
 */
export function desenhoDoMapa(raiz: string, mapa: MapaMental, medir: Medir, rtl = false, traduzir: (r: string) => string = r => r): DesenhoDoMapa {
  const M = MEDIDAS_DO_DESENHO;
  const arvore: No = {
    texto: raiz, nivel: 0,
    filhos: mapa.ramos.map(ramo => ({
      texto: traduzir(ramo.rotulo), nivel: 1,
      filhos: ramo.folhas.map(folha => ({ texto: traduzir(folha.rotulo), nivel: 2, filhos: folha.filhos.map(filho => ({ texto: traduzir(filho), nivel: 3, filhos: [] as No[] })) })),
    })),
  };
  const colunaX = [0, 1, 2, 3].map(n => M.margem + M.coluna.slice(0, n).reduce((a, b) => a + b, 0) + n * M.espacoEntreColunas);
  const niveis = arvore.filhos.some(r => r.filhos.some(f => f.filhos.length)) ? 4 : arvore.filhos.some(r => r.filhos.length) ? 3 : 2;
  const largura = colunaX[niveis - 1] + M.coluna[niveis - 1] + M.margem;
  const caixas: CaixaDoDesenho[] = [];
  const ligacoes: LigacaoDoDesenho[] = [];
  let proximoY = M.margem;

  function caixa(no: No): { linhas: string[]; altura: number; largura: number } {
    const util = M.coluna[no.nivel] - 2 * M.folgaInterna;
    const linhas = quebrarTexto(no.texto, util, t => medir(t, no.nivel));
    const larguraDoTexto = Math.max(...linhas.map(l => medir(l, no.nivel)), 0);
    return { linhas, altura: linhas.length * M.alturaDaLinha[no.nivel] + 2 * M.folgaInterna, largura: Math.min(M.coluna[no.nivel], Math.ceil(larguraDoTexto) + 2 * M.folgaInterna) };
  }

  // Devolve o centro vertical do nó: a folha da árvore ocupa a próxima linha;
  // o nó com filhos fica no meio deles.
  function posicionar(no: No): { x: number; yCentro: number; largura: number } {
    const medida = caixa(no);
    let yCentro: number;
    const centros = no.filhos.map(posicionar);
    if (centros.length) {
      yCentro = (centros[0].yCentro + centros[centros.length - 1].yCentro) / 2;
      // O nó mais alto que os filhos empurra a linha seguinte.
      proximoY = Math.max(proximoY, yCentro + medida.altura / 2 + M.espacoEntreLinhas);
    } else {
      yCentro = proximoY + medida.altura / 2;
      proximoY += medida.altura + M.espacoEntreLinhas;
    }
    const x = colunaX[no.nivel];
    caixas.push({ x, y: yCentro - medida.altura / 2, largura: medida.largura, altura: medida.altura, linhas: medida.linhas, nivel: no.nivel });
    for (const filho of centros) ligacoes.push({ de: { x: x + medida.largura, y: yCentro }, para: { x: filho.x, y: filho.yCentro } });
    return { x, yCentro, largura: medida.largura };
  }

  posicionar(arvore);
  // A raiz e os nós de cima não começam acima da margem.
  const topo = Math.min(...caixas.map(c => c.y));
  const deslocar = topo < M.margem ? M.margem - topo : 0;
  for (const c of caixas) c.y += deslocar;
  for (const l of ligacoes) { l.de.y += deslocar; l.para.y += deslocar; }
  const altura = Math.max(...caixas.map(c => c.y + c.altura)) + M.margem;

  if (rtl) {
    for (const c of caixas) c.x = largura - c.x - c.largura;
    for (const l of ligacoes) { l.de.x = largura - l.de.x; l.para.x = largura - l.para.x; }
  }
  // Caixas em ordem de leitura (de cima para baixo, por nível): a ordem do desenho.
  caixas.sort((a, b) => a.nivel - b.nivel || a.y - b.y);
  return { largura: Math.ceil(largura), altura: Math.ceil(altura), caixas, ligacoes };
}

const CORES = {
  fundo: "#ffffff",
  linha: "#c98f70",
  caixa: ["#c98f70", "#f6e7da", "#ffffff", "#ffffff"] as const,
  borda: ["#c98f70", "#c98f70", "#d9c7b8", "#e6dcd3"] as const,
  texto: ["#1a120c", "#3b2416", "#2b2b2b", "#555555"] as const,
};
const PESO = ["700", "600", "400", "400"] as const;
const TAMANHO = [15, 14, 13, 12] as const;
const FAMILIA = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK SC', sans-serif";
export const fonteDoNivel = (nivel: 0 | 1 | 2 | 3) => `${PESO[nivel]} ${TAMANHO[nivel]}px ${FAMILIA}`;

/** Desenha o mapa num canvas novo, na escala pedida (2 = nítido na tela de retina), dentro do lado máximo. */
export function canvasDoMapa(raiz: string, mapa: MapaMental, rtl: boolean, traduzir?: (r: string) => string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("CANVAS_INDISPONIVEL");
  const medir: Medir = (texto, nivel) => { ctx.font = fonteDoNivel(nivel); return ctx.measureText(texto).width; };
  const desenho = desenhoDoMapa(raiz, mapa, medir, rtl, traduzir);
  const escala = Math.min(2, MEDIDAS_DO_DESENHO.ladoMaximo / Math.max(desenho.largura, desenho.altura));
  canvas.width = Math.round(desenho.largura * escala);
  canvas.height = Math.round(desenho.altura * escala);
  ctx.scale(escala, escala);
  ctx.fillStyle = CORES.fundo;
  ctx.fillRect(0, 0, desenho.largura, desenho.altura);
  ctx.strokeStyle = CORES.linha;
  ctx.lineWidth = 1.5;
  for (const { de, para } of desenho.ligacoes) {
    const meio = (de.x + para.x) / 2;
    ctx.beginPath();
    ctx.moveTo(de.x, de.y);
    ctx.bezierCurveTo(meio, de.y, meio, para.y, para.x, para.y);
    ctx.stroke();
  }
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textBaseline = "middle";
  for (const c of desenho.caixas) {
    ctx.fillStyle = CORES.caixa[c.nivel];
    ctx.strokeStyle = CORES.borda[c.nivel];
    ctx.beginPath();
    const raio = c.nivel <= 1 ? 10 : 7;
    if (typeof ctx.roundRect === "function") ctx.roundRect(c.x, c.y, c.largura, c.altura, raio);
    else ctx.rect(c.x, c.y, c.largura, c.altura);
    ctx.fill();
    ctx.stroke();
    ctx.font = fonteDoNivel(c.nivel);
    ctx.fillStyle = CORES.texto[c.nivel];
    ctx.textAlign = rtl ? "right" : "left";
    const alturaDaLinha = MEDIDAS_DO_DESENHO.alturaDaLinha[c.nivel];
    c.linhas.forEach((linha, i) => {
      const x = rtl ? c.x + c.largura - MEDIDAS_DO_DESENHO.folgaInterna : c.x + MEDIDAS_DO_DESENHO.folgaInterna;
      ctx.fillText(linha, x, c.y + MEDIDAS_DO_DESENHO.folgaInterna + alturaDaLinha * (i + 0.5));
    });
  }
  return canvas;
}

/** O JPEG do canvas. */
export function jpegDoCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolver, recusar) => {
    canvas.toBlob(blob => (blob ? resolver(blob) : recusar(new Error("JPEG_FALHOU"))), "image/jpeg", 0.92);
  });
}

/**
 * Um PDF de uma página, do tamanho da imagem (em pontos, 72 por polegada, com
 * a imagem a 96 por polegada), com o JPEG dentro (DCTDecode). Puro: os
 * deslocamentos da tabela xref são contados nos bytes.
 */
export function pdfComJpeg(jpeg: Uint8Array, larguraPx: number, alturaPx: number): Uint8Array<ArrayBuffer> {
  const largura = Math.round(larguraPx * 0.75 * 100) / 100;
  const altura = Math.round(alturaPx * 0.75 * 100) / 100;
  const codificar = (texto: string) => new TextEncoder().encode(texto);
  const partes: Uint8Array[] = [];
  const deslocamentos: number[] = [];
  let tamanho = 0;
  const por = (bytes: Uint8Array) => { partes.push(bytes); tamanho += bytes.length; };
  const objeto = (n: number, corpo: string | Uint8Array[], ) => {
    deslocamentos[n] = tamanho;
    if (typeof corpo === "string") por(codificar(`${n} 0 obj\n${corpo}\nendobj\n`));
    else { por(codificar(`${n} 0 obj\n`)); corpo.forEach(por); por(codificar("\nendobj\n")); }
  };
  por(codificar("%PDF-1.4\n%âãÏÓ\n"));
  objeto(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objeto(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objeto(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${largura} ${altura}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`);
  objeto(4, [codificar(`<< /Type /XObject /Subtype /Image /Width ${larguraPx} /Height ${alturaPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, codificar("\nendstream")]);
  const conteudo = `q ${largura} 0 0 ${altura} 0 0 cm /Im1 Do Q`;
  objeto(5, `<< /Length ${codificar(conteudo).length} >>\nstream\n${conteudo}\nendstream`);
  const inicioDaXref = tamanho;
  const linhas = ["xref", "0 6", "0000000000 65535 f "];
  for (let n = 1; n <= 5; n++) linhas.push(`${String(deslocamentos[n]).padStart(10, "0")} 00000 n `);
  por(codificar(`${linhas.join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${inicioDaXref}\n%%EOF\n`));
  const saida = new Uint8Array(tamanho);
  let i = 0;
  for (const parte of partes) { saida.set(parte, i); i += parte.length; }
  return saida;
}

/** Entrega o arquivo ao navegador (o download do próprio aparelho). */
export function entregarArquivo(conteudo: Blob, nome: string) {
  const url = URL.createObjectURL(conteudo);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
