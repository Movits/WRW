import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guarda: só server/sessao.ts assina JWT.
 *
 * A sessão de usuária nasce em abrirSessao, que grava a linha em `sessions` e
 * põe o sessionToken dela no token. O assinador antigo do sdk fazia token sem
 * sessionToken, com 1 ano de validade e fora do alcance da revogação (sair,
 * redefinir a senha, desativar e excluir a conta). Hoje o sdk.authenticateRequest
 * recusa esse token; esta varredura avisa já no CI se alguém voltar a assinar
 * JWT fora do módulo da sessão (a passkey abre a sessão por abrirSessao, não
 * por conta própria). Varre server/ e shared/ (que também roda no servidor),
 * fora dos testes.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Quem pode assinar JWT, com o motivo. O cron (/api/scheduled/*) não entra: o
 * token dele (openId `cron_`, claim taskUid) é assinado fora do servidor, pelo
 * agendador que tiver o JWT_SECRET, e nenhum código daqui o assina. Se um dia
 * o servidor assinar o do cron, o arquivo entra aqui com o motivo.
 */
const PODEM_ASSINAR = new Map<string, string>([
  ["server/sessao.ts", "abrirSessao e a renovação: o token leva o sessionToken da linha gravada em sessions"],
]);

const PADROES = [/\bsignSession\s*\(/, /\bSignJWT\b/];
const PASTAS = ["server", "shared"];
const CODIGO = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TESTE = /\.(test|spec)\.[cm]?[jt]sx?$/;

type Arquivo = { caminho: string; texto: string };

/** Os arquivos de código das pastas, com o caminho relativo à raiz e barras normais. */
function arquivosDeCodigo(): Arquivo[] {
  const arquivos: Arquivo[] = [];
  const visitar = (pasta: string) => {
    for (const entrada of readdirSync(pasta, { withFileTypes: true })) {
      const completo = path.join(pasta, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name !== "node_modules") visitar(completo);
        continue;
      }
      if (!CODIGO.test(entrada.name) || TESTE.test(entrada.name)) continue;
      arquivos.push({
        caminho: path.relative(RAIZ, completo).split(path.sep).join("/"),
        texto: readFileSync(completo, "utf8"),
      });
    }
  };
  for (const pasta of PASTAS) visitar(path.join(RAIZ, pasta));
  return arquivos;
}

/** Cada linha que assina JWT fora de PODEM_ASSINAR, como "arquivo:linha: trecho". */
function assinaturasForaDoLugar(arquivos: Arquivo[]): string[] {
  return arquivos.flatMap(({ caminho, texto }) => {
    if (PODEM_ASSINAR.has(caminho)) return [];
    return texto.split("\n").flatMap((linha, i) =>
      PADROES.some(padrao => padrao.test(linha)) ? [`${caminho}:${i + 1}: ${linha.trim()}`] : [],
    );
  });
}

/** Os módulos que um arquivo de server/ importa, resolvidos a partir da raiz (sem extensão). */
function importadosPor(arquivo: Arquivo): string[] {
  const especificadores = [...arquivo.texto.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map(m => m[1]);
  const pasta = path.posix.dirname(arquivo.caminho);
  return especificadores.map(e => (e.startsWith(".") ? path.posix.join(pasta, e).replace(/\.[cm]?[jt]sx?$/, "") : e));
}

describe("guarda: a sessão nasce só em server/sessao.ts", () => {
  const arquivos = arquivosDeCodigo();

  it("a varredura enxerga o servidor de verdade (lista vazia passaria sem olhar nada)", () => {
    const caminhos = arquivos.map(arquivo => arquivo.caminho);
    expect(caminhos).toEqual(
      expect.arrayContaining(["server/_core/sdk.ts", "server/auth.ts", "server/sessao.ts", "server/routers/auth.ts", "shared/const.ts"]),
    );
    expect(caminhos.some(caminho => TESTE.test(caminho))).toBe(false);
  });

  it("nenhum arquivo fora de server/sessao.ts assina JWT (sdk.signSession nem SignJWT do jose)", () => {
    expect(
      assinaturasForaDoLugar(arquivos),
      "abra a sessão por abrirSessao (server/sessao.ts); se o arquivo precisar mesmo assinar JWT, ele entra em PODEM_ASSINAR com o motivo",
    ).toEqual([]);
  });

  it("cada arquivo da lista existe e assina de fato (a lista não guarda permissão velha)", () => {
    for (const [caminho, motivo] of PODEM_ASSINAR) {
      const arquivo = arquivos.find(candidato => candidato.caminho === caminho);
      expect(arquivo, `${caminho} (${motivo}) não existe mais`).toBeDefined();
      expect(arquivo!.texto).toMatch(/\bSignJWT\b/);
    }
  });

  it("pega uma chamada nova: o assinador antigo de volta, um SignJWT por conta própria e o import com outro nome", () => {
    const novos: Arquivo[] = [
      { caminho: "server/routers/passkeys.ts", texto: 'const token = await sdk.signSession({ openId, appId: "mmm-os", name });' },
      { caminho: "server/_core/sdk.ts", texto: "class SDKServer {\n  async signSession (payload: SessionPayload) {\n  }\n}" },
      { caminho: "server/outro.ts", texto: 'import { SignJWT as Assinar } from "jose";\nconst jwt = await new Assinar({ openId }).sign(segredo);' },
      { caminho: "shared/ajuda.ts", texto: "export const assinar = (claims: object) => new jose.SignJWT(claims);" },
      // O módulo da sessão pode.
      { caminho: "server/sessao.ts", texto: "const token = await new jose.SignJWT({ sessionToken }).sign(JWT_SECRET);" },
    ];

    expect(assinaturasForaDoLugar(novos)).toEqual([
      'server/routers/passkeys.ts:1: const token = await sdk.signSession({ openId, appId: "mmm-os", name });',
      "server/_core/sdk.ts:2: async signSession (payload: SessionPayload) {",
      'server/outro.ts:1: import { SignJWT as Assinar } from "jose";',
      "shared/ajuda.ts:1: export const assinar = (claims: object) => new jose.SignJWT(claims);",
    ]);
  });

  it("server/sessao.ts não importa server/auth.ts: auth.ts importa a sessão, e o contrário fecharia um ciclo", () => {
    const sessao = arquivos.find(arquivo => arquivo.caminho === "server/sessao.ts");
    const auth = arquivos.find(arquivo => arquivo.caminho === "server/auth.ts");
    expect(sessao, "server/sessao.ts não existe").toBeDefined();
    expect(auth, "server/auth.ts não existe").toBeDefined();

    const daSessao = importadosPor(sessao!);
    // A leitura dos imports funciona (lista vazia passaria sem olhar nada).
    expect(daSessao).toEqual(expect.arrayContaining(["server/db", "jose"]));
    expect(daSessao).not.toContain("server/auth");
    expect(importadosPor(auth!)).toContain("server/sessao");
  });
});
