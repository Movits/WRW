import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
  process.env.ENTIDADES_HMAC_KEY =
    "chave-hmac-das-entidades-so-para-testes-0123456789";
  process.env.VAULT_ENCRYPTION_KEY =
    "chave-do-cofre-so-para-testes-0123456789abcdef";
});

/**
 * Teste de CARGA da base das associações (N4b): 50 mil associados fictícios
 * numa entidade, num banco LOCAL novo, e o tempo de cada passo. Não roda na
 * suíte comum: só com `RODAR_CARGA_N4B=1` e `DATABASE_URL_TESTES` apontando
 * para um banco descartável recém-migrado (ele não apaga o que cria, para a
 * medida poder ser repetida e lida depois). Recusa banco que não seja local.
 *
 *   DATABASE_URL_TESTES='mysql://root:...@127.0.0.1:3307/n4b_carga' RODAR_CARGA_N4B=1 \
 *     corepack pnpm vitest run server/carga-das-entidades.carga.test.ts
 *
 * Mede, com os mesmos dados (gerador com semente fixa), o que o código da
 * branch tiver: a importação pelo painel (blocos de 500), a leitura global
 * (quantos associados ela alcança), a busca de uma membra comum na rede global,
 * o cruzamento da própria entidade com a rede, o motor privado na conta da
 * entidade e o resumo do Meu Network. O mesmo arquivo serviu para medir a
 * `main` (o "antes", com o teto de associados subido só para a medida) e a N4b;
 * os números estão em docs/arquitetura/entidades.md, seção 8.
 */
// O insight de IA do motor de perfis não sai para a rede na medida: a chamada falha na hora (o motor já a trata).
vi.mock("./_core/llm", () => ({
  invokeLLM: async () => {
    throw new Error("sem IA na medida de carga");
  },
}));

const ligado =
  process.env.RODAR_CARGA_N4B === "1" &&
  Boolean(process.env.DATABASE_URL_TESTES);
/** Quantas contas de membra criar para medir o motor de perfis (os associados que ativam a conta, N3). 0 pula. */
const USUARIAS = Number(process.env.CARGA_N4B_USUARIAS ?? 0);
/** Associados NO TOTAL, somando as entidades (a meta: 50 mil no app inteiro). */
const ASSOCIADOS = Number(process.env.CARGA_N4B_ASSOCIADOS ?? 50_000);
/** Associados por entidade: a primeira é a maior; as outras levam o resto. */
const POR_ENTIDADE = Number(process.env.CARGA_N4B_POR_ENTIDADE ?? 30_000);
const SAIDA = process.env.CARGA_N4B_SAIDA;

/** PRNG com semente (mulberry32): os mesmos dados no antes e no depois. */
function gerador(semente: number) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cnpj(base12: string): string {
  const dv = (b: string, pesos: number[]) => {
    const resto = pesos.reduce((s, p, i) => s + Number(b[i]) * p, 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base12 + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base12}${d1}${d2}`;
}

/** O que a entidade escreve em "o que tem" e "o que precisa": termos comuns de quem vende e de quem compra. */
const OFERTAS = [
  "Café especial",
  "Vinho tinto",
  "Exportação de café",
  "Consultoria tributária",
  "Transporte de cargas",
  "Software de gestão",
  "Embalagens plásticas",
  "Galpão logístico",
  "Advocacia tributária",
  "Contabilidade para pequenas empresas",
  "Soja em grão",
  "Mel orgânico",
  "Tradução juramentada",
  "Energia solar",
  "Móveis planejados",
  "Uniformes profissionais",
  "Manutenção de máquinas industriais",
  "Queijos artesanais",
];
const NECESSIDADES = [
  "Importar café",
  "Importar vinho",
  "Contador",
  "Advogado tributarista",
  "Transporte rodoviário de carga",
  "Embalagens plásticas",
  "Software de gestão",
  "Consultoria em internacionalização",
  "Distribuidor para a África",
  "Serviços advocatícios",
  "Exportar café",
  "Assessoria tributária",
  "Energia solar",
  "Certificação orgânica",
  "Fornecedor de uniformes",
  "Manutenção de máquinas",
  "Crédito para capital de giro",
  "Queijos artesanais",
];
const UFS = ["SP", "RJ", "MG", "PR", "SC", "RS", "BA", "PE", "GO", "DF"];

function linhasDaPlanilha(n: number) {
  const sorte = gerador(20261125);
  const cnaes = Object.keys(
    (
      JSON.parse(
        fs.readFileSync(
          new URL("./cnae/cnae-2-3.json", import.meta.url),
          "utf8"
        )
      ) as { subclasses: Record<string, string> }
    ).subclasses
  );
  const um = <T>(lista: T[]) => lista[Math.floor(sorte() * lista.length)];
  const linhas: Array<Record<string, string>> = [];
  for (let i = 0; i < n; i += 1) {
    const linha: Record<string, string> = {
      documento: cnpj(String(70_000_000_0000 + i).padStart(12, "0")),
      nome: `Empresa Fictícia de Carga ${i}`,
      uf: um(UFS),
      cnae_principal: um(cnaes),
    };
    const secundarias = Math.floor(sorte() * 3);
    if (secundarias)
      linha.cnaes_secundarios = Array.from({ length: secundarias }, () =>
        um(cnaes)
      ).join(";");
    if (sorte() < 0.2)
      linha.o_que_tem = Array.from(
        { length: 1 + Math.floor(sorte() * 2) },
        () => um(OFERTAS)
      ).join(";");
    if (sorte() < 0.1) {
      linha.o_que_precisa = Array.from(
        { length: 1 + Math.floor(sorte() * 2) },
        () => um(NECESSIDADES)
      ).join(";");
      linha.data_da_declaracao = "01/11/2026";
    }
    linhas.push(linha);
  }
  return linhas;
}

const medidas: Record<string, unknown> = {};
/** O tempo de cada passo e o pico de memória do processo (RSS) durante ele, que é o que a instância de 2 GB do Render aguenta. */
async function medir<T>(nome: string, trabalho: () => Promise<T>): Promise<T> {
  const inicio = performance.now();
  let pico = process.memoryUsage().rss;
  const relogio = setInterval(() => {
    pico = Math.max(pico, process.memoryUsage().rss);
  }, 50);
  const resultado = await trabalho();
  clearInterval(relogio);
  const ms = Math.round(performance.now() - inicio);
  medidas[nome] = { ms, rssPicoMb: Math.round(pico / 1e6), ...(medidas[nome] as object | undefined) };
  console.log(`[carga] ${nome}: ${ms} ms, pico de ${Math.round(pico / 1e6)} MB`);
  return resultado;
}
const anotar = (nome: string, extra: Record<string, unknown>) => {
  medidas[nome] = { ...(medidas[nome] as object | undefined), ...extra };
  console.log(`[carga] ${nome}:`, JSON.stringify(extra));
};

describe.skipIf(!ligado)(
  "Carga: associados fictícios numa entidade (N4b)",
  () => {
    it(
      "mede a importação, a leitura global, os cruzamentos e o resumo",
      { timeout: 6 * 60 * 60_000 },
      async () => {
        const url = new URL(
          process.env.DATABASE_URL_TESTES!.replace(/^mysql:/, "http:")
        );
        expect(["127.0.0.1", "localhost"]).toContain(url.hostname);

        const { getDb } = await import("./db");
        const { LINHAS_POR_ARQUIVO_MAX } = await import("../shared/entidades");
        const {
          users,
          privateContacts,
          contactAssets,
          contactNeeds,
          userProfiles,
        } = await import("../drizzle/schema");
        const { appRouter } = await import("./routers");
        const redeGlobal = (await import("./network-rede-global")) as Record<
          string,
          unknown
        > &
          typeof import("./network-rede-global");
        const { recalculatePrivateMatches, scoreMatch, slugifyMatchTag } =
          await import("./match-service");
        const { resumoDoNetworkInteligente } = await import(
          "./network-inteligente"
        );
        const fila = (await import("./fila-de-cruzamento").catch(
          () => null
        )) as null | Record<string, (...args: never[]) => Promise<unknown>>;
        const indice = (await import("./indice-de-cruzamento").catch(
          () => null
        )) as null | Record<string, (...args: never[]) => Promise<unknown>>;
        const db = (await getDb())!;

        const sufixo = crypto.randomUUID().slice(0, 8);
        const QUANTAS_ENTIDADES = Math.ceil(ASSOCIADOS / POR_ENTIDADE);
        const ENTIDADES = Array.from(
          { length: QUANTAS_ENTIDADES },
          (_, i) => `carga-entidade-${i}-${sufixo}`
        );
        // A maior: é nela que se medem o cruzamento da base inteira, o motor privado e o resumo.
        const ENTIDADE = ENTIDADES[0];
        const MEMBRA = `carga-membra-${sufixo}`;
        const STAFF = `carga-staff-${sufixo}`;
        const PERFIS = Array.from(
          { length: 20 },
          (_, i) => `carga-perfil-${i}-${sufixo}`
        );
        await db
          .insert(users)
          .values([
            ...ENTIDADES.map(openId => ({
              openId,
              email: `${openId}@exemplo.com`,
              onboardingCompleted: true,
            })),
            {
              openId: MEMBRA,
              email: `carga-membra-${sufixo}@exemplo.com`,
              onboardingCompleted: true,
            },
            { openId: STAFF, role: "admin", onboardingCompleted: true },
            ...PERFIS.map(openId => ({ openId, onboardingCompleted: true })),
          ]);
        const contas = await db
          .select({ id: users.id, openId: users.openId })
          .from(users)
          .where(
            inArray(users.openId, [...ENTIDADES, MEMBRA, STAFF, ...PERFIS])
          );
        const id = Object.fromEntries(contas.map(c => [c.openId, c.id]));
        const rota = (openId: string, extra: Record<string, unknown> = {}) =>
          appRouter.createCaller({
            user: {
              id: id[openId],
              openId,
              role: "silver",
              onboardingCompleted: true,
              isEntidade: false,
              ...extra,
            },
            req: { headers: {} },
            res: { cookie: () => {} },
          } as never);

        // As entidades, com o convênio ativo e os associados disponíveis por padrão (decisão 4).
        for (const [i, openId] of ENTIDADES.entries()) {
          await rota(STAFF, { role: "admin" }).entidades.admin.criar({
            tipo: "associacao",
            convenioEstado: "ativo",
            convenioInicio: null,
            convenioFim: null,
            convenioReferencia: "Carga",
            mostrarNomeNoMatch: false,
            disponivelPorPadrao: true,
            nome: `Associação de Carga ${i}`,
            pais: "BR",
            emailDaConta: `${openId}@exemplo.com`,
          });
        }

        // A membra comum: 40 contatos disponíveis na rede global, com os mesmos termos.
        const sorte = gerador(7);
        const agora = Date.now();
        await db.insert(privateContacts).values(
          Array.from({ length: 40 }, (_, i) => ({
            ownerId: MEMBRA,
            fullName: `Contato ${i}`,
            codigoAnonimo:
              `CG${sufixo.slice(0, 4)}${String(i).padStart(2, "0")}`.toUpperCase(),
            disponivelRedeGlobal: true,
            nivelVisibilidade: "privado" as const,
            createdAt: agora,
            updatedAt: agora,
          }))
        );
        const daMembra = await db
          .select({ id: privateContacts.id })
          .from(privateContacts)
          .where(eq(privateContacts.ownerId, MEMBRA));
        const item = (contactId: number, label: string) => ({
          ownerId: MEMBRA,
          contactId,
          tagSlug: slugifyMatchTag(label),
          tagLabel: label,
          category: null,
          description: null,
          createdAt: agora,
          updatedAt: agora,
        });
        await db
          .insert(contactAssets)
          .values(
            daMembra.map(c =>
              item(Number(c.id), OFERTAS[Math.floor(sorte() * OFERTAS.length)])
            )
          );
        await db
          .insert(contactNeeds)
          .values(
            daMembra.flatMap(c => [
              item(
                Number(c.id),
                NECESSIDADES[Math.floor(sorte() * NECESSIDADES.length)]
              ),
              item(
                Number(c.id),
                NECESSIDADES[Math.floor(sorte() * NECESSIDADES.length)]
              ),
            ])
          );
        // E 20 perfis de membras com "o que tenho" e "o que preciso".
        await db.insert(userProfiles).values(
          PERFIS.map(
            (openId, i) =>
              ({
                userId: id[openId],
                whatIHave: [OFERTAS[i % OFERTAS.length]],
                whatINeed: [NECESSIDADES[i % NECESSIDADES.length]],
              }) as never
          )
        );

        // 1. A importação pelo painel: iniciar, blocos de 500, concluir.
        const linhas = linhasDaPlanilha(ASSOCIADOS);
        // Cada entidade importa a sua parte; uma planilha tem até LINHAS_POR_ARQUIVO_MAX linhas (50 mil).
        await medir("importacao", async () => {
          for (const [e, openId] of ENTIDADES.entries()) {
            const daEntidade = rota(openId, { isEntidade: true });
            const daParte = linhas.slice(
              e * POR_ENTIDADE,
              (e + 1) * POR_ENTIDADE
            );
            for (
              let arquivo = 0;
              arquivo * LINHAS_POR_ARQUIVO_MAX < daParte.length;
              arquivo += 1
            ) {
              const doArquivo = daParte.slice(
                arquivo * LINHAS_POR_ARQUIVO_MAX,
                (arquivo + 1) * LINHAS_POR_ARQUIVO_MAX
              );
              const { importacaoId } =
                await daEntidade.entidades.iniciarImportacao({
                  modo: "aplicar",
                  arquivoSha256: String(arquivo).repeat(64),
                  totalLinhas: doArquivo.length,
                });
              for (let inicio = 0; inicio < doArquivo.length; inicio += 500) {
                await daEntidade.entidades.importarBloco({
                  importacaoId,
                  inicio,
                  linhas: doArquivo.slice(inicio, inicio + 500),
                });
              }
              await daEntidade.entidades.concluirImportacao({ importacaoId });
            }
          }
        });
        const [ativos, necessidades] = await Promise.all([
          db
            .select({ id: contactAssets.id })
            .from(contactAssets)
            .where(inArray(contactAssets.ownerId, ENTIDADES)),
          db
            .select({ id: contactNeeds.id })
            .from(contactNeeds)
            .where(inArray(contactNeeds.ownerId, ENTIDADES)),
        ]);
        anotar("importacao", {
          associados: ASSOCIADOS,
          entidades: QUANTAS_ENTIDADES,
          porEntidade: POR_ENTIDADE,
          itensTem: ativos.length,
          itensPreciso: necessidades.length,
        });

        // O índice (N4b) alcança o que a carga gravou; no antes, não existe.
        if (indice?.indexarPendentes) {
          await medir("indice_pendentes", async () => {
            let total = 0;
            for (;;) {
              const n = Number(
                await (
                  indice.indexarPendentes as (
                    db: unknown,
                    limite?: number
                  ) => Promise<number>
                )(db, 20_000)
              );
              total += n;
              if (!n) break;
            }
            anotar("indice_pendentes", { itensIndexados: total });
          });
        }

        // 2. A leitura global: quantos associados a leitura alcança.
        await medir("leitura_global", async () => {
          let lidos: Array<{ ownerId: string }> = [];
          if (typeof redeGlobal.lerRedeGlobalPaginada === "function") {
            for await (const pagina of (
              redeGlobal.lerRedeGlobalPaginada as (
                o: object
              ) => AsyncIterable<Array<{ ownerId: string }>>
            )({ excetoDona: MEMBRA }))
              lidos = lidos.concat(pagina);
          } else {
            lidos = await redeGlobal.lerRedeGlobalAnonima({
              excetoDona: MEMBRA,
            });
          }
          anotar("leitura_global", {
            lidos: lidos.length,
            associadosAlcancados: lidos.filter(l =>
              ENTIDADES.includes(l.ownerId)
            ).length,
          });
        });

        // 3. A busca de uma membra comum (40 contatos) na rede global.
        await medir("busca_da_membra", async () => {
          const r = await redeGlobal.procurarConexoesNaRedeGlobal({
            id: id[MEMBRA],
            openId: MEMBRA,
          });
          anotar("busca_da_membra", {
            conexoes: r.conexoes.length,
            completa: r.completa,
            comAssociados: r.conexoes.filter(
              c => c.outroLado.tipo === "contato"
            ).length,
          });
        });

        // 4. O cruzamento da própria entidade com a rede (a base inteira).
        await medir("cruzamento_da_entidade", async () => {
          const r = (await redeGlobal.procurarConexoesNaRedeGlobal({
            id: id[ENTIDADE],
            openId: ENTIDADE,
          })) as Awaited<
            ReturnType<typeof redeGlobal.procurarConexoesNaRedeGlobal>
          > & { emFila?: boolean };
          if (r.emFila && fila?.rodarFilaAteEsvaziar) {
            const feito = await (
              fila.rodarFilaAteEsvaziar as (
                o: object
              ) => Promise<{ lotes: number; conexoes: number }>
            )({ ownerId: ENTIDADE });
            anotar("cruzamento_da_entidade", {
              emFila: true,
              lotes: feito.lotes,
              conexoes: feito.conexoes,
              completa: true,
            });
          } else {
            anotar("cruzamento_da_entidade", {
              emFila: false,
              conexoes: r.conexoes.length,
              completa: r.completa,
            });
          }
        });

        // 5. O motor privado na conta da entidade.
        const [tem, precisa] = await Promise.all([
          db
            .select({
              label: contactAssets.tagLabel,
              slug: contactAssets.tagSlug,
              category: contactAssets.category,
              contactId: contactAssets.contactId,
            })
            .from(contactAssets)
            .where(eq(contactAssets.ownerId, ENTIDADE)),
          db
            .select({
              label: contactNeeds.tagLabel,
              slug: contactNeeds.tagSlug,
              category: contactNeeds.category,
              contactId: contactNeeds.contactId,
            })
            .from(contactNeeds)
            .where(eq(contactNeeds.ownerId, ENTIDADE)),
        ]);
        // A taxa do laço antigo (todos os "tenho" × todos os "preciso"), numa amostra de 300 mil pares.
        const amostra = gerador(99);
        const inicioDaAmostra = performance.now();
        const PARES_DA_AMOSTRA = 300_000;
        for (let k = 0; k < PARES_DA_AMOSTRA; k += 1) {
          const a = tem[Math.floor(amostra() * tem.length)];
          const b = precisa[Math.floor(amostra() * precisa.length)];
          scoreMatch(
            { slug: a.slug, label: a.label, category: a.category },
            { slug: b.slug, label: b.label, category: b.category }
          );
        }
        const porSegundo =
          PARES_DA_AMOSTRA / ((performance.now() - inicioDaAmostra) / 1000);
        anotar("motor_privado_laco_antigo", {
          pares: tem.length * precisa.length,
          paresPorSegundo: Math.round(porSegundo),
          estimativaSegundos: Math.round(
            (tem.length * precisa.length) / porSegundo
          ),
        });
        if (fila?.enfileirarCruzamento) {
          await medir("motor_privado", async () => {
            await (
              fila.enfileirarCruzamento as (o: object) => Promise<unknown>
            )({ ownerId: ENTIDADE, userId: id[ENTIDADE], tipo: "privado" });
            const feito = await (
              fila.rodarFilaAteEsvaziar as (
                o: object
              ) => Promise<{ lotes: number }>
            )({ ownerId: ENTIDADE });
            anotar("motor_privado", { emFila: true, lotes: feito.lotes });
          });
        } else if (process.env.CARGA_N4B_MOTOR_PRIVADO_ANTIGO === "1") {
          await medir("motor_privado", async () => {
            const r = await recalculatePrivateMatches(ENTIDADE);
            anotar("motor_privado", { total: r.total });
          });
        }
        const { aiMatchSuggestions } = await import("../drizzle/schema");
        const sugestoes = await db
          .select({ id: aiMatchSuggestions.id })
          .from(aiMatchSuggestions)
          .where(eq(aiMatchSuggestions.ownerId, ENTIDADE));
        anotar("motor_privado", { sugestoes: sugestoes.length });

        // 6. O resumo do Meu Network Inteligente na conta da entidade.
        await medir("resumo_do_meu_network", async () => {
          const antes = process.memoryUsage().heapUsed;
          const r = await resumoDoNetworkInteligente(ENTIDADE, {
            termoSmartMatch: true,
          });
          anotar("resumo_do_meu_network", {
            contatos: r.contatos.total,
            incompletos: r.contatos.incompletos,
            heapMb: Math.round((process.memoryUsage().heapUsed - antes) / 1e6),
          });
        });

        // Nenhuma coluna pessoal sai da leitura global (a regra de consulta segue valendo).
        const umaPagina = await redeGlobal.lerRedeGlobalAnonima({
          excetoDona: MEMBRA,
          ...(typeof redeGlobal.lerRedeGlobalPaginada === "function"
            ? { limite: 5 }
            : {}),
        } as never);
        for (const linha of umaPagina.slice(0, 5))
          expect(Object.keys(linha).sort()).toEqual([
            "codigoAnonimo",
            "contactId",
            "ownerId",
            "preciso",
            "tenho",
          ]);

        // 7. O motor de perfis com USUARIAS contas (o associado que ativa vira usuária e cruza com todas).
        if (USUARIAS > 0) {
          const { generateMatchesForUser } = await import("./matching");
          const prefixo = `carga-usuaria-${sufixo}-`;
          await medir("criar_usuarias", async () => {
            const sorteDoPerfil = gerador(31);
            for (let inicio = 0; inicio < USUARIAS; inicio += 2000) {
              const lote = Array.from(
                { length: Math.min(2000, USUARIAS - inicio) },
                (_, i) => `${prefixo}${inicio + i}`
              );
              await db
                .insert(users)
                .values(
                  lote.map(openId => ({ openId, onboardingCompleted: true }))
                );
              const criadas = await db
                .select({ id: users.id })
                .from(users)
                .where(inArray(users.openId, lote));
              await db.insert(userProfiles).values(
                criadas.map(
                  c =>
                    ({
                      userId: c.id,
                      whatIHave: [
                        OFERTAS[Math.floor(sorteDoPerfil() * OFERTAS.length)],
                      ],
                      whatINeed: [
                        NECESSIDADES[
                          Math.floor(sorteDoPerfil() * NECESSIDADES.length)
                        ],
                      ],
                      sector: [
                        "Agronegócio",
                        "Tecnologia",
                        "Saúde",
                        "Indústria",
                        "Serviços",
                      ][Math.floor(sorteDoPerfil() * 5)],
                      primarySpecialty: "Gestão",
                      city: "São Paulo",
                      country: "BR",
                    }) as never
                )
              );
            }
          });
          const [uma] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.openId, `${prefixo}0`));
          await medir("motor_de_perfis_uma_rodada", async () => {
            if (global.gc) global.gc();
            const antes = process.memoryUsage();
            let pico = antes.rss;
            const relogio = setInterval(() => {
              pico = Math.max(pico, process.memoryUsage().rss);
            }, 50);
            const novas = await generateMatchesForUser(uma.id);
            clearInterval(relogio);
            anotar("motor_de_perfis_uma_rodada", {
              usuarias: USUARIAS,
              novas,
              rssAntesMb: Math.round(antes.rss / 1e6),
              rssPicoMb: Math.round(pico / 1e6),
            });
          });
        }

        // 8. O tamanho no banco (dados e índices) das tabelas que crescem com os associados e as usuárias.
        // As estatísticas do information_schema ficam velhas depois de uma carga grande: ANALYZE antes.
        for (const tabela of [
          "users", "user_profiles", "private_contacts", "contact_assets", "contact_needs", "entidade_membros",
          "chaves_de_cruzamento", "ai_match_suggestions", "conexoes_registradas", "conexoes_participantes", "matches", "audit_logs",
        ]) {
          await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(sql`analyze table ${sql.identifier(tabela)}`);
        }
        const [tamanhos] = await (
          db as unknown as {
            execute: (q: unknown) => Promise<[Array<Record<string, unknown>>]>;
          }
        ).execute(
          sql`select table_name as tabela, table_rows as linhas, data_length as dados, index_length as indices
           from information_schema.tables where table_schema = database() and (data_length + index_length) > 1048576
           order by data_length + index_length desc`
        );
        const mb = (n: unknown) => Math.round(Number(n) / 1e5) / 10;
        anotar("tamanho_no_banco", {
          totalMb: mb(
            tamanhos.reduce(
              (soma, t) => soma + Number(t.dados) + Number(t.indices),
              0
            )
          ),
          tabelas: tamanhos.map(t => ({
            tabela: t.tabela,
            linhas: Number(t.linhas),
            dadosMb: mb(t.dados),
            indicesMb: mb(t.indices),
          })),
        });

        if (SAIDA)
          fs.writeFileSync(
            SAIDA,
            JSON.stringify(
              {
                quando: new Date().toISOString(),
                associados: ASSOCIADOS,
                medidas,
              },
              null,
              2
            )
          );
        console.log("[carga] medidas:", JSON.stringify(medidas, null, 2));
        void and;
      }
    );
  }
);
