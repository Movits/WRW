// O slug de uma tag, igual ao de shared/direcao-do-termo.ts (slugDoTermo), para
// os scripts .mjs gravarem o mesmo tag_slug que o servidor grava. O teste
// server/rede-com-armadilhas.test.ts confere que os dois dão o mesmo resultado
// para todos os rótulos da rede: mudou lá, este teste avisa.
const DIACRITICO_APOS_LATINA = new RegExp("(\\p{Script=Latin})[\\u0300-\\u036f]+", "gu");
const SEPARADOR_DE_PALAVRA = new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu");

export function slugDaTag(valor) {
  const normalizado = valor.normalize("NFKD").replace(DIACRITICO_APOS_LATINA, "$1").normalize("NFC").toLowerCase();
  const slug = normalizado.replace(SEPARADOR_DE_PALAVRA, "-").replace(/^-+|-+$/g, "");
  return Array.from(slug).slice(0, 160).join("");
}
