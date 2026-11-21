import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Express, Request, Response } from "express";

/**
 * Os arquivos que o leitor de PDF da tela (pdf.js, H12b) busca fora do bundle,
 * servidos da própria node_modules (a imagem de produção leva a pasta inteira,
 * ver o Dockerfile), num endereço com a versão instalada:
 *
 * - os dois decodificadores de imagem em JavaScript: o de JBIG2 e CCITT (o
 *   preto e branco do escâner, a forma mais comum do PDF escaneado) e o de
 *   JPEG 2000. O pdf.js os carrega por import dinâmico de `${wasmUrl}<nome>`
 *   quando a tela pede `useWasm: false` (client/src/lib/leitor-de-pdf.ts). A
 *   versão em WebAssembly fica de fora de propósito: compilar WebAssembly pede
 *   'wasm-unsafe-eval' no script-src, e a CSP de produção é só 'self'
 *   (server/_core/csp.ts, travada em server/csp.test.ts). Sem eles, a página
 *   escaneada aparece em branco;
 * - os mapas de caracteres (`cmaps/*.bcmap`), sem os quais o texto em chinês,
 *   japonês ou coreano de fonte não embutida sai em branco;
 * - as fontes padrão (`standard_fonts/*.pfb` e `*.ttf`), que desenham o texto
 *   do PDF que usa Helvetica, Times ou Courier sem embuti-las.
 *
 * Só sai o que está nesta lista ou numa das duas pastas, lida uma vez (o nome
 * pedido nunca vira caminho: é chave de um mapa), só na versão de agora (outra
 * versão é 404), sem sessão (são arquivos da biblioteca, Apache-2.0, e das
 * fontes livres que ela traz, sem dado de ninguém) e com cache longo, porque a
 * versão no caminho muda quando a biblioteca muda. Sem eles, o texto lido pela
 * IA continua na aba do texto.
 */

export const ROTA_DOS_ARQUIVOS_DO_LEITOR_DE_PDF = "/pdfjs/:versao/:arquivo";
export const ROTA_DAS_PASTAS_DO_LEITOR_DE_PDF = "/pdfjs/:versao/:pasta/:arquivo";

export const ARQUIVOS_DO_LEITOR_DE_PDF = ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"] as const;

/** As pastas de dados que o leitor busca por fetch, com os nomes que valem em cada uma. */
export const PASTAS_DO_LEITOR_DE_PDF = {
  cmaps: /^[A-Za-z0-9-]+\.bcmap$/,
  standard_fonts: /^[A-Za-z0-9-]+\.(pfb|ttf)$/,
} as const;

type Pacote = { pasta: string; versao: string };
type ArquivoServido = { caminho: string; tipo: string };

const requerer = createRequire(import.meta.url);

/** A pasta e a versão do pdfjs-dist instalado, lidas uma vez. */
function pacoteInstalado(): Pacote {
  const caminhoDoPacote = requerer.resolve("pdfjs-dist/package.json");
  const { version } = requerer("pdfjs-dist/package.json") as { version: string };
  return { pasta: path.dirname(caminhoDoPacote), versao: version };
}

/** Tudo o que pode sair, pelo nome pedido ("<arquivo>" ou "<pasta>/<arquivo>"). */
export function arquivosDoLeitorDePdf(pacote: Pacote): Map<string, ArquivoServido> {
  const mapa = new Map<string, ArquivoServido>();
  for (const arquivo of ARQUIVOS_DO_LEITOR_DE_PDF) {
    mapa.set(arquivo, { caminho: path.join(pacote.pasta, "wasm", arquivo), tipo: "text/javascript; charset=utf-8" });
  }
  for (const [pasta, nomeValido] of Object.entries(PASTAS_DO_LEITOR_DE_PDF)) {
    let nomes: string[];
    try {
      nomes = fs.readdirSync(path.join(pacote.pasta, pasta));
    } catch {
      // A pasta que não veio na versão instalada só deixa o leitor sem ela.
      nomes = [];
    }
    for (const nome of nomes) {
      if (nomeValido.test(nome)) mapa.set(`${pasta}/${nome}`, { caminho: path.join(pacote.pasta, pasta, nome), tipo: "application/octet-stream" });
    }
  }
  return mapa;
}

export function registrarArquivosDoLeitorDePdf(app: Express, pacote: Pacote = pacoteInstalado()) {
  const servidos = arquivosDoLeitorDePdf(pacote);
  const servir = (req: Request, res: Response, nome: string) => {
    const arquivo = servidos.get(nome);
    if (req.params.versao !== pacote.versao || !arquivo) return res.status(404).end();
    res.setHeader("Content-Type", arquivo.tipo);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(arquivo.caminho);
  };
  app.get(ROTA_DOS_ARQUIVOS_DO_LEITOR_DE_PDF, (req: Request, res: Response) => servir(req, res, String(req.params.arquivo ?? "")));
  app.get(ROTA_DAS_PASTAS_DO_LEITOR_DE_PDF, (req: Request, res: Response) => servir(req, res, `${String(req.params.pasta ?? "")}/${String(req.params.arquivo ?? "")}`));
}
