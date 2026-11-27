import { ambienteDoNavegador, calcularDestino, type AmbienteDeImagem } from "./reduzir-imagem";

/**
 * As fotos de um texto viram um PDF no próprio aparelho (H12b do desenho do
 * gravador): uma página por foto, na ordem em que a dona as tirou ou escolheu.
 * Assim o servidor recebe sempre um PDF (server/documento-da-reuniao.ts), guarda
 * um arquivo só, a IA lê as páginas numa chamada só e a tela
 * mostra as fotos página a página, como o PDF enviado.
 *
 * Cada foto é endireitada pela orientação EXIF, reduzida (o lado maior com até
 * LADO_MAXIMO_DA_FOTO_DO_TEXTO) e recodificada em JPEG, que o PDF guarda como
 * está (filtro DCTDecode): não há biblioteca de PDF, só o arquivo montado à mão,
 * com a tabela de posições que os leitores exigem.
 */

/**
 * 1800 px no lado maior: a página A4 fotografada inteira fica com ~150 pontos
 * por polegada, o bastante para a IA ler texto impresso e manuscrito legível
 * (a régua de digitalização de documento é ~200 ppp para a página com margem).
 */
export const LADO_MAXIMO_DA_FOTO_DO_TEXTO = 1800;

/** 0,8: o ponto em que o JPEG não esfarela a borda das letras (ver reduzir-imagem.ts). */
export const QUALIDADE_DA_FOTO_DO_TEXTO = 0.8;

/** A página do PDF tem o lado maior de uma folha A4 (842 pontos) e o outro na proporção da foto. */
const LADO_MAIOR_DA_PAGINA_PT = 842;

export type JpegDaPagina = { bytes: Uint8Array; largura: number; altura: number };

/** A foto que o navegador não conseguiu abrir ou recodificar (formato que ele não lê, canvas bloqueado). */
export class FotoIlegivel extends Error {
  constructor(readonly posicao: number) {
    super(`A foto ${posicao + 1} não pôde ser preparada.`);
    this.name = "FotoIlegivel";
  }
}

const ascii = (texto: string) => new TextEncoder().encode(texto);
/** Número com até duas casas e ponto decimal, como o PDF escreve. */
const numero = (valor: number) => String(Math.round(valor * 100) / 100);

/**
 * O PDF de uma página por JPEG. Exportada para o teste provar a forma do
 * arquivo (cabeçalho, objetos, tabela de posições e trailer), sem canvas.
 */
export function montarPdfDeJpegs(paginas: readonly JpegDaPagina[]): Uint8Array<ArrayBuffer> {
  if (!paginas.length) throw new Error("Nenhuma página para o PDF.");
  const partes: Uint8Array[] = [];
  const posicoes: number[] = [];
  let tamanho = 0;
  const escrever = (pedaco: Uint8Array) => { partes.push(pedaco); tamanho += pedaco.length; };
  const abrirObjeto = (numeroDoObjeto: number) => { posicoes[numeroDoObjeto] = tamanho; escrever(ascii(`${numeroDoObjeto} 0 obj\n`)); };

  // O comentário com bytes acima de 127 diz aos programas que o arquivo é binário.
  escrever(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Objetos: 1 é o catálogo, 2 a lista de páginas, e cada página i usa três
  // (a página, a imagem e o desenho): 3 + 3i, 4 + 3i e 5 + 3i.
  const objetoDaPagina = (i: number) => 3 + 3 * i;
  abrirObjeto(1);
  escrever(ascii("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  abrirObjeto(2);
  escrever(ascii(`<< /Type /Pages /Kids [${paginas.map((_, i) => `${objetoDaPagina(i)} 0 R`).join(" ")}] /Count ${paginas.length} >>\nendobj\n`));

  paginas.forEach((pagina, i) => {
    if (!(pagina.largura > 0 && pagina.altura > 0) || !pagina.bytes.length) throw new Error(`A página ${i + 1} está vazia.`);
    const escala = LADO_MAIOR_DA_PAGINA_PT / Math.max(pagina.largura, pagina.altura);
    const largura = numero(pagina.largura * escala);
    const altura = numero(pagina.altura * escala);
    const [objPagina, objImagem, objDesenho] = [objetoDaPagina(i), objetoDaPagina(i) + 1, objetoDaPagina(i) + 2];
    abrirObjeto(objPagina);
    escrever(ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${largura} ${altura}] /Resources << /XObject << /Im0 ${objImagem} 0 R >> >> /Contents ${objDesenho} 0 R >>\nendobj\n`));
    abrirObjeto(objImagem);
    escrever(ascii(`<< /Type /XObject /Subtype /Image /Width ${pagina.largura} /Height ${pagina.altura} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pagina.bytes.length} >>\nstream\n`));
    escrever(pagina.bytes);
    escrever(ascii("\nendstream\nendobj\n"));
    const desenho = ascii(`q ${largura} 0 0 ${altura} 0 0 cm /Im0 Do Q`);
    abrirObjeto(objDesenho);
    escrever(ascii(`<< /Length ${desenho.length} >>\nstream\n`));
    escrever(desenho);
    escrever(ascii("\nendstream\nendobj\n"));
  });

  // A tabela de posições: cada linha tem exatamente 20 bytes.
  const totalDeObjetos = 2 + 3 * paginas.length;
  const inicioDaTabela = tamanho;
  let tabela = `xref\n0 ${totalDeObjetos + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalDeObjetos; n++) tabela += `${String(posicoes[n]).padStart(10, "0")} 00000 n \n`;
  tabela += `trailer\n<< /Size ${totalDeObjetos + 1} /Root 1 0 R >>\nstartxref\n${inicioDaTabela}\n%%EOF\n`;
  escrever(ascii(tabela));

  const pdf = new Uint8Array(tamanho);
  let posicao = 0;
  for (const parte of partes) { pdf.set(parte, posicao); posicao += parte.length; }
  return pdf;
}

/** Os bytes de um data: URL em base64. */
function bytesDoDataUrl(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

/**
 * Uma foto endireitada, reduzida e em JPEG. Lança FotoIlegivel quando o
 * navegador não a abre, não confia na leitura do canvas (navegador contra
 * fingerprinting, que devolveria outra imagem) ou não codifica JPEG.
 */
export async function fotoParaJpeg(foto: File, posicao: number, ambiente: AmbienteDeImagem = ambienteDoNavegador): Promise<JpegDaPagina> {
  let aberta: Awaited<ReturnType<AmbienteDeImagem["abrir"]>>;
  try {
    aberta = await ambiente.abrir(foto);
  } catch {
    throw new FotoIlegivel(posicao);
  }
  if (!aberta) throw new FotoIlegivel(posicao);
  try {
    if (!ambiente.leituraConfiavel()) throw new FotoIlegivel(posicao);
    const { largura, altura } = calcularDestino(aberta.largura, aberta.altura, LADO_MAXIMO_DA_FOTO_DO_TEXTO);
    if (!largura || !altura) throw new FotoIlegivel(posicao);
    const dataUrl = await aberta.paraDataUrl(largura, altura, "image/jpeg", QUALIDADE_DA_FOTO_DO_TEXTO);
    if (!dataUrl?.startsWith("data:image/jpeg")) throw new FotoIlegivel(posicao);
    return { bytes: bytesDoDataUrl(dataUrl), largura, altura };
  } catch (erro) {
    throw erro instanceof FotoIlegivel ? erro : new FotoIlegivel(posicao);
  } finally {
    aberta.fechar();
  }
}

/**
 * As fotos num PDF, uma de cada vez (a memória do celular não segura vinte
 * fotos abertas juntas). `aoAvancar` recebe quantas já estão prontas, para a
 * tela mostrar o andamento.
 */
export async function fotosParaPdf(fotos: readonly File[], opcoes: { aoAvancar?: (prontas: number) => void; ambiente?: AmbienteDeImagem } = {}): Promise<Blob> {
  const paginas: JpegDaPagina[] = [];
  for (let posicao = 0; posicao < fotos.length; posicao++) {
    paginas.push(await fotoParaJpeg(fotos[posicao], posicao, opcoes.ambiente));
    opcoes.aoAvancar?.(paginas.length);
  }
  return new Blob([montarPdfDeJpegs(paginas)], { type: "application/pdf" });
}
