import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import configuracao from "../vite.config";

/**
 * (Mora em server/ pelo mesmo motivo de fonte-nao-vira-data-uri.test.ts: o
 * vite.config.ts não carrega no jsdom do projeto client.)
 *
 * O pdf.js (o leitor das páginas do documento, H12b) entra na tela só quando a
 * aba das páginas abre, por import() dinâmico (client/src/lib/leitor-de-pdf.ts)
 * e pelo Worker (client/src/workers/leitor-de-pdf.worker.ts). O servidor de dev
 * do Vite não acha esses módulos na varredura da subida: na primeira abertura
 * da aba, ele os otimizava e recarregava a página inteira, que voltava para a
 * aba Resumo (conferência de tela de 20/11/2026). Todo módulo do pdfjs-dist que
 * o client importa tem de estar em optimizeDeps.include.
 */

const RAIZ = path.resolve(import.meta.dirname, "..");

function arquivosDoClient(pasta: string): string[] {
  return readdirSync(pasta).flatMap(nome => {
    const caminho = path.join(pasta, nome);
    if (statSync(caminho).isDirectory()) return arquivosDoClient(caminho);
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.(ts|tsx)$/.test(nome) ? [caminho] : [];
  });
}

/** Os módulos do pdfjs-dist que o código do client importa (estático, dinâmico ou só pelo efeito). */
function modulosDoPdfjsNoClient(): string[] {
  const modulos = new Set<string>();
  for (const arquivo of arquivosDoClient(path.join(RAIZ, "client", "src"))) {
    const codigo = readFileSync(arquivo, "utf8");
    for (const achado of codigo.matchAll(/(?:import\s*\(\s*|from\s+|import\s+)["'](pdfjs-dist\/[^"']+)["']/g)) modulos.add(achado[1]);
  }
  return Array.from(modulos).sort();
}

describe("o servidor de dev otimiza o pdf.js na subida, sem recarregar a página na primeira abertura das páginas", () => {
  it("o client importa os dois módulos do pdf.js de sempre (a lista abaixo não está vazia por engano)", () => {
    expect(modulosDoPdfjsNoClient()).toEqual(["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs"]);
  });

  it("todo módulo do pdfjs-dist que o client importa está em optimizeDeps.include", () => {
    const incluidos = (configuracao as { optimizeDeps?: { include?: string[] } }).optimizeDeps?.include ?? [];
    for (const modulo of modulosDoPdfjsNoClient()) expect(incluidos, modulo).toContain(modulo);
  });
});
