// Demonstração ao vivo da etapa 11 — a autorização do Cruzamento Inteligente.
//
// Não descreve o que o código deveria fazer: chama as MESMAS funções que o
// servidor chama e mostra o que elas responderam agora, contra este banco.
//
// Uso:
//   DATABASE_URL='mysql://root:root@127.0.0.1:3306/wrw_dev' npx tsx scripts/demonstrar-etapa-11.ts
//   ...mesma coisa com --exercitar para revogar e reaceitar de verdade, provando
//      que a trava fecha e abre. O estado é devolvido como estava ao final.

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../server/db";
import { getCurrentDocument, hasValidConsent } from "../server/routers/consent";
import { scoreMatch } from "../server/match-service";
import { analisarTermo } from "@shared/direcao-do-termo";
import { consents, contactAssets, contactNeeds, users } from "../drizzle/schema";

const exercitar = process.argv.includes("--exercitar");
const t = (b: boolean) => (b ? "SIM" : "NÃO");
const titulo = (n: number, s: string) => console.log(`\n${"─".repeat(72)}\n${n}. ${s}\n${"─".repeat(72)}`);

const db = await getDb();
if (!db) { console.error("Banco indisponível."); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
titulo(1, "EXISTE TERMO PUBLICADO?");

const documento = await getCurrentDocument("termo_smart_match");
if (!documento) {
  console.log("  Não há versão vigente do termo.");
  console.log("  CONSEQUÊNCIA: hasValidConsent devolve true para todo mundo e a");
  console.log("  trava não barra ninguém. A etapa 11 estaria instalada e inerte.");
} else {
  console.log(`  Sim: ${documento.type} versão ${documento.version}`);
  console.log(`  Publicado em ${documento.publishedAt}`);
  console.log(`  Texto com ${documento.text.length} caracteres`);
  console.log(`  Primeira linha: ${documento.text.split("\n")[0]}`);
  console.log("\n  Isto é o que faz a trava sair do papel: sem documento vigente");
  console.log("  ela libera todo mundo de propósito.");
}

// ─────────────────────────────────────────────────────────────────────────────
titulo(2, "QUEM ACEITOU, DE VERDADE");

const aceites = await db
  .select({ id: consents.id, userId: consents.userId, grantedAt: consents.grantedAt, revokedAt: consents.revokedAt, docId: consents.documentVersionId })
  .from(consents);
const pessoas = new Map((await db.select({ id: users.id, name: users.name, email: users.email }).from(users)).map(u => [u.id, u]));

if (!aceites.length) console.log("  Nenhum consentimento registrado.");
for (const a of aceites) {
  const p = pessoas.get(a.userId);
  const vigente = documento && a.docId === documento.id;
  console.log(`  #${a.id}  ${p?.name ?? "(usuária apagada)"} <${p?.email ?? "?"}>`);
  console.log(`        aceito em ${a.grantedAt}${a.revokedAt ? `  REVOGADO em ${a.revokedAt}` : ""}`);
  console.log(`        aponta para a versão vigente? ${t(Boolean(vigente))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
titulo(3, "A TRAVA DISCRIMINA? (chamando a função real do servidor)");

// Precisa ser um aceite NA VERSÃO VIGENTE: revogar mexe só nas linhas dela, e
// exercitar sobre aceite de versão antiga não muda nada — as setas do
// relatório mentiriam. A primeira versão desta linha pegava o primeiro aceite
// não revogado de qualquer versão, e foi exatamente o que aconteceu.
const comAceite = aceites.find(a => !a.revokedAt && documento && a.docId === documento.id)?.userId;
const semAceite = Array.from(pessoas.keys()).find(id => !aceites.some(a => a.userId === id && !a.revokedAt)) ?? 999_999;

for (const [rotulo, uid] of [["quem aceitou", comAceite], ["quem NÃO aceitou", semAceite]] as const) {
  if (uid === undefined) { console.log(`  ${rotulo}: ninguém nesta situação`); continue; }
  const liberado = await hasValidConsent(uid, "termo_smart_match");
  const quem = pessoas.get(uid);
  console.log(`  ${rotulo.padEnd(18)} userId ${String(uid).padEnd(10)} ${quem?.name ?? "(inexistente)"}`);
  console.log(`  ${"".padEnd(18)} hasValidConsent -> ${liberado ? "LIBERA o cruzamento" : "BARRA o cruzamento"}`);
}

// ─────────────────────────────────────────────────────────────────────────────
titulo(4, "A REGRA DA DIREÇÃO, NOS TERMOS QUE ESTÃO NO BANCO");

const possuidos = await db.select({ label: contactAssets.tagLabel, cat: contactAssets.category }).from(contactAssets);
const procurados = await db.select({ label: contactNeeds.tagLabel, cat: contactNeeds.category }).from(contactNeeds);
const rotulos = Array.from(new Set([...possuidos, ...procurados].map(x => x.label)));

console.log("  Como cada termo real da base é lido:\n");
console.log(`  ${"termo".padEnd(34)} ${"direção".padEnd(9)} objeto`);
for (const r of rotulos.slice(0, 24)) {
  const a = analisarTermo(r);
  console.log(`  ${r.slice(0, 33).padEnd(34)} ${a.direcao.padEnd(9)} ${a.objeto}`);
}

const vinhoPossui = possuidos.find(x => /exportar vinho/i.test(x.label));
const vinhoProcura = procurados.filter(x => /vinho/i.test(x.label));
if (vinhoPossui && vinhoProcura.length) {
  console.log("\n  O cruzamento par a par, com o motivo da decisão:\n");
  for (const p of vinhoProcura) {
    const r = scoreMatch(
      { slug: "", label: vinhoPossui.label, category: vinhoPossui.cat },
      { slug: "", label: p.label, category: p.cat },
    ) as { score: number; type: string; bloqueio?: string };
    const veredito = r.bloqueio === "concorrentes"
      ? "BARRADO — as duas pontas querem a mesma coisa, são concorrentes"
      : r.score >= 100 ? "MÁXIMO — mesmo objeto, direções opostas: é aqui que existe negócio"
      : r.score > 0 ? `${r.score} por ${r.type}`
      : "sem match";
    console.log(`  possui "${vinhoPossui.label}"  ×  procura "${p.label}"`);
    console.log(`     -> ${veredito}\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
if (!exercitar) {
  titulo(5, "PARA VER A TRAVA FECHAR E ABRIR");
  console.log("  Rode de novo com --exercitar: o script revoga o consentimento,");
  console.log("  mostra a trava barrando, reaceita e mostra a trava liberando —");
  console.log("  devolvendo o banco ao estado atual no final.");
  process.exit(0);
}

titulo(5, "EXERCITANDO: REVOGAR -> BARRAR -> REACEITAR -> LIBERAR");
if (comAceite === undefined || !documento) { console.log("  Sem consentimento ativo para exercitar."); process.exit(0); }

console.log(`  exercitando com ${pessoas.get(comAceite)?.name ?? comAceite}, que tem aceite na versão vigente
`);
console.log(`  antes            hasValidConsent -> ${t(await hasValidConsent(comAceite, "termo_smart_match"))}`);

await db.update(consents).set({ revokedAt: new Date() })
  .where(and(eq(consents.userId, comAceite), eq(consents.documentVersionId, documento.id), isNull(consents.revokedAt)));
console.log(`  depois de revogar hasValidConsent -> ${t(await hasValidConsent(comAceite, "termo_smart_match"))}   <- a trava fechou`);

await db.update(consents).set({ revokedAt: null })
  .where(and(eq(consents.userId, comAceite), eq(consents.documentVersionId, documento.id)));
console.log(`  depois de reaceitar hasValidConsent -> ${t(await hasValidConsent(comAceite, "termo_smart_match"))}   <- a trava abriu`);
console.log("\n  Banco devolvido ao estado inicial.");
process.exit(0);
