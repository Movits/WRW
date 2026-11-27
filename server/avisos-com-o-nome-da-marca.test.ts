import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO, VERSOES_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA, VERSOES_DO_AVISO_DA_LEGENDA } from "@shared/legenda-ao-vivo";
import { VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE, VERSOES_DO_AVISO_DO_YOUTUBE } from "@shared/youtube";

/**
 * O nome nos avisos versionados (pedido da Cris de 24/11/2026: onde constar o
 * nome anterior, entra Marquesa Global Match). O texto dos avisos de gravação,
 * da legenda e do YouTube cita a plataforma pelo nome; mudou o texto, a versão
 * é nova, e as anteriores seguem aceitas para a aba aberta antes do deploy (o
 * servidor grava a que veio). Aqui: os 10 idiomas dizem o nome novo, nenhum diz
 * o de 23/11, e a versão vigente é a mais nova (no aviso de gravação, a de
 * 26/11, que mudou a retenção do áudio), com as anteriores na lista.
 */

const LOCALES = fileURLToPath(new URL("../client/src/i18n/locales/", import.meta.url));
const IDIOMAS = ["pt-BR", "en", "es", "fr", "de", "ar", "hi", "ja", "ru", "zh"];

type Dicionario = { [chave: string]: string | Dicionario };

function texto(idioma: string, caminho: string): string {
  const raiz = JSON.parse(readFileSync(join(LOCALES, `${idioma}.json`), "utf8")) as Dicionario;
  const valor = caminho.split(".").reduce<string | Dicionario | undefined>(
    (no, parte) => (no && typeof no === "object" ? no[parte] : undefined), raiz);
  if (typeof valor !== "string") throw new Error(`${idioma}: a chave ${caminho} não existe`);
  return valor;
}

const AVISOS = [
  { nome: "gravação", chave: "meetings.consentNotice", vigente: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO, versoes: VERSOES_DO_AVISO_DE_GRAVACAO as readonly string[], nova: "2026-11-26", anteriores: ["2026-11-14", "2026-11-23", "2026-11-24"] },
  { nome: "legenda", chave: "meetings.caption.noticeBrowser", vigente: VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA, versoes: VERSOES_DO_AVISO_DA_LEGENDA as readonly string[], nova: "legenda-2026-11-24", anteriores: ["legenda-2026-11-22", "legenda-2026-11-23"] },
  { nome: "YouTube", chave: "meetings.youtube.notice", vigente: VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE, versoes: VERSOES_DO_AVISO_DO_YOUTUBE as readonly string[], nova: "youtube-2026-11-24", anteriores: ["youtube-2026-11-20"] },
];

describe("os avisos versionados com o nome Marquesa Global Match (24/11/2026)", () => {
  for (const aviso of AVISOS) {
    it(`${aviso.nome}: os 10 idiomas dizem Marquesa Global Match, em caracteres latinos, e nenhum diz MarquesaMatch`, () => {
      for (const idioma of IDIOMAS) {
        const valor = texto(idioma, aviso.chave);
        expect(valor, idioma).toContain("Marquesa Global Match");
        expect(valor, idioma).not.toMatch(/MarquesaMatch|\bWRW\b/);
      }
    });

    it(`${aviso.nome}: a versão vigente é a nova, no fim da lista, e as anteriores seguem aceitas`, () => {
      expect(aviso.vigente).toBe(aviso.nova);
      expect(aviso.versoes.at(-1)).toBe(aviso.nova);
      for (const anterior of aviso.anteriores) expect(aviso.versoes).toContain(anterior);
    });
  }
});
