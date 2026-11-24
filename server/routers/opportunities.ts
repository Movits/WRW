import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { goldProcedure } from "./_procedures";
import { invokeLLM } from "../_core/llm";
import {
  exigirDb,
  listOpportunities, getOpportunityById, createOpportunity,
  getDocumentsByOpportunity,
  expressInterest, getInterestsByOpportunity,
  desfazerOportunidadeSalva, salvarOportunidade, getSavedOpportunities,
  createNotification,
} from "../db";
import { createAuditLog } from "../security";
import { exigirTextoSemContato } from "../bloqueio-de-contato";
import { exigirLeituraDaOportunidade, exigirSalvarOportunidade, podeVerConfidencial } from "../oportunidade-acesso";
import { opportunityMatches, opportunities as opportunitiesTable, users } from "../../drizzle/schema";

// ============================================================
// A MESMA OPORTUNIDADE, A MESMA NOTA
// ============================================================
// Reteste v4, item 1: o mesmo anúncio recebia notas de confiança diferentes
// (88, 75, 75) e fatores de risco diferentes a cada publicação. São duas
// causas somadas. A primeira é a chamada: ia sem temperatura, então o modelo
// amostrava uma resposta nova toda vez — daí o `temperature: 0` em TODAS as
// análises de oportunidade deste arquivo. A segunda é a ausência de memória:
// nada ligava a análise ao que foi analisado, e a mesma entrada pagava uma ida
// nova ao modelo.
//
// São QUATRO chamadas, não uma. A nota vem da análise de criação e da reanálise
// por documento; os FATORES DE RISCO e a LISTA DE DOCUMENTOS SUGERIDOS que a
// usuária vê enquanto preenche o formulário vêm de outras duas
// (`analyzeForCompliance` e `suggestDocuments`). Estabilizar só as primeiras
// deixava a tela do cadastro trocando de risco e de documento a cada digitada,
// que foi o que o reteste seguinte ainda reclamou. As quatro passam pela mesma
// regra.
//
// A memória é POR CONTEÚDO: título, descrição, tipo, setor, país e o conjunto
// de documentos viram um hash, e enquanto o hash não muda a análise anterior é
// reaproveitada. Mudou uma vírgula da descrição ou entrou um documento NOVO, é
// conteúdo novo e o modelo é consultado de novo.
//
// Só entra na memória o que DEU CERTO. Análise que falhou (modelo fora do ar,
// resposta que não é JSON) devolve o texto de reserva e não é guardada: senão a
// primeira falha grudaria em todas as publicações seguintes do mesmo anúncio.
//
// A memória é do PROCESSO, não do banco: `opportunities` guarda a análise
// (complianceLevel, complianceExplanation, suggestedDocuments,
// frauenTrustScore, lastComplianceAt), mas NÃO tem coluna para o hash do que
// foi analisado, e criar uma exigiria migração. Consequência assumida: todo
// reinício do servidor (isto é, todo deploy) esvazia a memória e a próxima
// análise volta ao modelo — com temperatura 0, para cair na mesma nota.
type AnaliseDeCompliance = {
  nivel: "green" | "yellow" | "orange" | "red";
  explicacao: string;
  documentosSugeridos: string[];
  nota: number;
};

const TETO_DE_ANALISES_GUARDADAS = 500;

// Uma memória por formato de resposta guardada. O hash já separa as etapas,
// mas cada memória tem o seu tipo: misturar os quatro formatos numa tabela só
// obrigaria a confiar num `as` toda vez que a resposta fosse lida de volta.
const criarMemoriaPorConteudo = <T>() => {
  const guardadas = new Map<string, T>();
  return {
    ler(hash: string): T | undefined {
      const guardada = guardadas.get(hash);
      if (guardada === undefined) return undefined;
      // Descarte por menos usada recentemente: reler recoloca no fim da fila.
      guardadas.delete(hash);
      guardadas.set(hash, guardada);
      return guardada;
    },
    guardar(hash: string, valor: T) {
      guardadas.set(hash, valor);
      // Teto, para a memória não crescer sem fim num processo de semanas.
      while (guardadas.size > TETO_DE_ANALISES_GUARDADAS) {
        const maisAntiga = guardadas.keys().next();
        if (maisAntiga.done) break;
        guardadas.delete(maisAntiga.value);
      }
    },
  };
};

const memoriaDeCompliance = criarMemoriaPorConteudo<AnaliseDeCompliance>();
// As duas do cadastro devolvem JSON solto para a tela (a forma é a do
// json_schema logo abaixo de cada chamada), então a memória guarda o objeto
// como veio do modelo.
const memoriaDoCadastro = criarMemoriaPorConteudo<Record<string, unknown>>();
const memoriaDeDocumentosSugeridos = criarMemoriaPorConteudo<Record<string, unknown>>();

// CONJUNTO de documentos, não lista: nomes repetidos contam uma vez só, e a
// ordem não importa. Sem isso o caminho de upload nunca reaproveitava nada — o
// documento novo é GRAVADO antes de a lista ser lida de volta, então cada envio
// devolvia uma lista maior que a da análise anterior e o hash jamais coincidia,
// nem quando a usuária reenviava exatamente o mesmo arquivo.
const conjuntoDeDocumentos = (nomes: readonly (string | null | undefined)[]): string[] =>
  Array.from(new Set(nomes.map(nome => (nome ?? "").trim()).filter(Boolean))).sort();

// A etapa entra no hash porque os prompts são diferentes (o da criação pede
// documentos sugeridos; o da reanálise, não): sem ela, duas análises de
// conteúdos iguais em etapas diferentes se confundiriam.
const hashDoConteudoAnalisado = (
  etapa: "criacao" | "reanalise" | "cadastro" | "documentos",
  conteudo: {
    titulo?: string;
    descricao?: string;
    tipo: string;
    setor?: string | null;
    pais?: string | null;
    documentos?: string[];
  },
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        etapa,
        conteudo.titulo ?? "",
        conteudo.descricao ?? "",
        conteudo.tipo,
        conteudo.setor ?? "",
        conteudo.pais ?? "",
        conjuntoDeDocumentos(conteudo.documentos ?? []),
      ]),
    )
    .digest("hex");

// A tela mostra os dois textos da IA juntos; o formato é o mesmo nas duas
// análises, então mora num lugar só.
const explicacaoCombinada = (r: { riskAnalysis?: string; explanation: string }): string =>
  r.riskAnalysis
    ? `**Análise de Risco:** ${r.riskAnalysis}\n\n**Status de Confiança:** ${r.explanation}`
    : r.explanation;

// ============================================================
// OPORTUNIDADES — CORE DA PLATAFORMA FRAUEN
// ============================================================
export const opportunitiesRouter = router({
  // Listar oportunidades (Prata vê apenas públicas; Ouro vê também confidenciais)
  list: protectedProcedure
    .input(z.object({
      type: z.enum(["offer", "demand", "investment", "partnership", "distribution", "other"]).optional(),
      sector: z.string().optional(),
      country: z.string().length(2).optional(),
      complianceLevel: z.enum(["green", "yellow", "orange", "red"]).optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const isGold = ctx.user.role === "gold" || ctx.user.role === "admin" || ctx.user.role === "president";
      const opps = await listOpportunities({
        ...input,
        // Prata só vê oportunidades não confidenciais
        isConfidential: isGold ? undefined : false,
        viewerUserId: ctx.user.id,
      });
      return opps;
    }),

  // Detalhe de uma oportunidade
  get: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const opp = await getOpportunityById(input.id);
      if (!opp) throw new TRPCError({ code: "NOT_FOUND" });

      // A régua (rejeitada, pendente, confidencial) mora em
      // server/oportunidade-acesso.ts, compartilhada com toggleSave — era só
      // daqui, e o favorito virou porta lateral para a confidencial.
      const { isGold, isOwner } = exigirLeituraDaOportunidade(opp, ctx.user);

      // Incrementar view count apenas para oportunidades ativas e quando não é a própria criadora
      if (opp.status === "active" && !isOwner) {
        const db = await exigirDb();
        await db.update(opportunitiesTable).set({ viewCount: (opp.viewCount ?? 0) + 1 }).where(eq(opportunitiesTable.id, input.id));
      }

      const docs = await getDocumentsByOpportunity(input.id, isGold || isOwner);
      return { ...opp, documents: docs };
    }),

  // Publicar nova oportunidade
  create: protectedProcedure
    .input(z.object({
      title: z.string().min(10).max(300),
      description: z.string().min(30).max(5000),
      type: z.enum(["offer", "demand", "investment", "partnership", "distribution", "other"]),
      sector: z.string().optional(),
      country: z.string().length(2).optional(),
      region: z.string().optional(),
      tags: z.array(z.string()).max(10).default([]),
      isConfidential: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      // A13: oportunidade é broadcast para o ecossistema inteiro — título,
      // descrição e tags não carregam e-mail/telefone (a moderação humana
      // continua por cima, mas a porta é a mesma dos outros canais).
      await exigirTextoSemContato(
        ctx.user.id, "opportunities.create",
        [input.title, input.description, ...input.tags].join("\n"),
      );
      // Análise de compliance pela IA
      let complianceLevel: "green" | "yellow" | "orange" | "red" | "pending" = "pending";
      let complianceExplanation = "";
      let suggestedDocuments: string[] = [];
      let frauenTrustScore = 50;

      // Anúncio idêntico já analisado: a nota anterior vale, sem nova ida ao
      // modelo (ver o bloco "A MESMA OPORTUNIDADE, A MESMA NOTA" acima).
      const hashDaAnalise = hashDoConteudoAnalisado("criacao", {
        titulo: input.title,
        descricao: input.description,
        tipo: input.type,
        setor: input.sector,
        pais: input.country,
      });
      const jaAnalisado = memoriaDeCompliance.ler(hashDaAnalise);

      if (jaAnalisado) {
        complianceLevel = jaAnalisado.nivel;
        complianceExplanation = jaAnalisado.explicacao;
        suggestedDocuments = jaAnalisado.documentosSugeridos;
        frauenTrustScore = jaAnalisado.nota;
      } else try {
        const aiResponse = await invokeLLM({
          // Temperatura 0: a nota de confiança é classificação, não redação.
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `Você é a IA de Compliance e Due Diligence do ecossistema global MarquesaMatch.

Sua tarefa ao analisar uma oportunidade de negócio:
1. Identificar os riscos preliminares da transação (campo: riskAnalysis — parágrafo curto em português)
2. Sugerir documentos obrigatórios com justificativa de cada um (campo: suggestedDocuments — lista de até 6 itens, cada um com nome e justificativa separados por ": ")
3. Classificar o nível de confiança inicial com cor e justificativa (campo: complianceLevel + explanation)

Classificação de nível de confiança:
- "green": Verde (Altamente documentado) — oportunidade clara, setor estabelecido, informações completas
- "yellow": Amarelo (Boa documentação, precisa complementar) — legítima mas com pontos de atenção
- "orange": Laranja (Pouco documentado, necessita validação) — informações incompletas, setor de alto risco
- "red": Vermelho (Baixa confiabilidade) — promessas irreais, esquemas de pirâmide, produtos ilegais

Retorne um JSON estruturado com os campos: complianceLevel, explanation, riskAnalysis, suggestedDocuments (array de strings), trustScore (0-100).`,
            },
            {
              role: "user",
              content: `Analise esta oportunidade:\n\nTítulo: ${input.title}\nTipo: ${input.type}\nSetor: ${input.sector ?? "não informado"}\nDescrição: ${input.description}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "compliance_analysis",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  complianceLevel: { type: "string", enum: ["green", "yellow", "orange", "red"] },
                  explanation: { type: "string" },
                  riskAnalysis: { type: "string" },
                  suggestedDocuments: { type: "array", items: { type: "string" } },
                  trustScore: { type: "number" },
                },
                required: ["complianceLevel", "explanation", "riskAnalysis", "suggestedDocuments", "trustScore"],
                additionalProperties: false,
              },
            },
          },
        });
        const result = JSON.parse(aiResponse.choices[0].message.content as string);
        complianceLevel = result.complianceLevel;
        // Combina riskAnalysis + explanation para exibição completa no frontend
        complianceExplanation = explicacaoCombinada(result);
        suggestedDocuments = result.suggestedDocuments;
        frauenTrustScore = result.trustScore;
        // Só o que deu certo fica guardado: análise que falhou nasce "pending"
        // e a próxima publicação tem de tentar de novo.
        memoriaDeCompliance.guardar(hashDaAnalise, {
          nivel: result.complianceLevel,
          explicacao: complianceExplanation,
          documentosSugeridos: suggestedDocuments,
          nota: frauenTrustScore,
        });
      } catch (e) {
        console.error("[Compliance AI] Erro:", e);
      }

      // Oportunidades RED são automaticamente rejeitadas
      const status = complianceLevel === "red" ? "rejected" : "pending";

      const id = await createOpportunity({
        publishedBy: ctx.user.id,
        title: input.title,
        description: input.description,
        type: input.type,
        sector: input.sector,
        country: input.country,
        region: input.region,
        tags: input.tags,
        isConfidential: input.isConfidential,
        complianceLevel,
        complianceExplanation,
        suggestedDocuments,
        frauenTrustScore,
        lastComplianceAt: new Date(),
        status,
      });

      await createAuditLog({ userId: ctx.user.id, action: "OPPORTUNITY_CREATE", resource: "opportunities", resourceId: String(id), status: "success", riskLevel: "low" });

      // A fila de validação era invisível: nada avisava a moderação de que uma
      // oportunidade nova esperava análise, e ela ficava parada indefinidamente.
      if (status === "pending") {
        try {
          const db = await exigirDb();
          const moderadoras = await db
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.role, ["president", "admin"]));
          for (const mod of moderadoras) {
            if (mod.id === ctx.user.id) continue;
            await createNotification({
              userId: mod.id,
              type: "system",
              title: "Nova oportunidade aguardando análise",
              body: `"${input.title.slice(0, 120)}" foi publicada e espera validação no painel.`,
              actionUrl: "/president",
            });
          }
        } catch (e) {
          console.error("[Opportunities] Falha ao notificar a moderação:", e);
        }
      }

      return { id, complianceLevel, complianceExplanation, suggestedDocuments, status };
    }),

  // Demonstrar interesse em uma oportunidade
  expressInterest: protectedProcedure
    .input(z.object({
      opportunityId: z.number().int(),
      message: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // A13: a mensagem de interesse chega à outra parte — sem contato nela.
      await exigirTextoSemContato(ctx.user.id, "opportunities.expressInterest", input.message, input.opportunityId);
      const result = await expressInterest(input.opportunityId, ctx.user.id, input.message);
      if (result.alreadyExists) throw new TRPCError({ code: "CONFLICT", message: "Você já demonstrou interesse nesta oportunidade" });
      return { success: true };
    }),

  // Listar interessados (apenas dona da oportunidade ou Ouro). Etapa 10: a
  // procedure era goldProcedure, o que tornava a guarda interna código morto
  // E trancava a própria criadora comum para fora da sua oportunidade — com
  // protectedProcedure a guarda "dona OU Ouro" passa a ser quem decide.
  getInterests: protectedProcedure
    .input(z.object({ opportunityId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const opp = await getOpportunityById(input.opportunityId);
      if (!opp) throw new TRPCError({ code: "NOT_FOUND" });
      if (opp.publishedBy !== ctx.user.id && ctx.user.role !== "admin" && ctx.user.role !== "president" && ctx.user.role !== "gold") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas quem criou a oportunidade pode ver os interessados" });
      }
      return getInterestsByOpportunity(input.opportunityId);
    }),

  // Salvar/remover oportunidade dos favoritos. Só se pode favoritar o que se
  // pode ler E o que a aba "Salvas" vai mostrar: a oportunidade é buscada e
  // passa pela régua de gravação (a de `get` mais o predicado de status das
  // listas). Antes a gravação ia direto para saved_opportunities (tabela sem
  // FK), e uma Prata enumerando ids salvava a confidencial sem nunca tê-la
  // visto. Desfazer vem ANTES e sem régua: a linha que já existe sai sempre,
  // senão um favorito antigo (ou de uma Ouro rebaixada) ficava órfão.
  toggleSave: protectedProcedure
    .input(z.object({ opportunityId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      if (await desfazerOportunidadeSalva(ctx.user.id, input.opportunityId)) {
        return { saved: false };
      }
      const opp = await getOpportunityById(input.opportunityId);
      if (!opp) throw new TRPCError({ code: "NOT_FOUND" });
      exigirSalvarOportunidade(opp, ctx.user);
      await salvarOportunidade(ctx.user.id, input.opportunityId);
      return { saved: true };
    }),

  // Listar oportunidades salvas — o filtro de confidencialidade e de status
  // roda NO BANCO (privacidade é regra de consulta): um favorito gravado antes
  // da guarda, ou uma oportunidade que virou confidencial depois, não volta
  // para quem não é Ouro nem dona.
  saved: protectedProcedure.query(async ({ ctx }) => {
    return getSavedOpportunities(ctx.user.id, { podeVerConfidencial: podeVerConfidencial(ctx.user.role) });
  }),

  // IA 4.1 — Análise dinâmica no cadastro: pergunta + sugestão de documentos por nicho
  analyzeForCompliance: protectedProcedure
    .input(z.object({
      title: z.string().min(3).max(300),
      sector: z.string().optional(),
      description: z.string().min(10),
      type: z.enum(["offer", "demand", "investment", "partnership", "distribution", "other"]),
    }))
    .mutation(async ({ input }) => {
      // Os fatores de risco e a lista de documentos desta tela são o que o
      // reteste viu mudar a cada publicação do mesmo anúncio: mesma entrada,
      // mesma resposta (ver o bloco no topo do arquivo).
      const hashDoCadastro = hashDoConteudoAnalisado("cadastro", {
        titulo: input.title,
        descricao: input.description,
        tipo: input.type,
        setor: input.sector,
      });
      const jaAnalisado = memoriaDoCadastro.ler(hashDoCadastro);
      if (jaAnalisado) return jaAnalisado;

      try {
        const aiResp = await invokeLLM({
          // Temperatura 0 pelo mesmo motivo das outras: risco e documentos são
          // classificação, não redação.
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `Você é a IA de Compliance e Due Diligence do ecossistema global MarquesaMatch.
Analise a oportunidade de negócio e retorne um JSON com:
- dynamicQuestion: uma pergunta direta e específica para quem publicou sobre como comprovar que esta oportunidade existe (ex: "Você possui contrato de fornecimento ou carta de intenção assinada?")
- suggestedDocuments: lista de 3 a 5 documentos específicos para este nicho/setor (ex: para Commodities → SGS, BL, Contrato de Fornecimento; para Tecnologia → Licença de Software, Termos de Uso, NDA)
- documentJustifications: justificativa breve para cada documento sugerido
- riskLevel: nível de risco preliminar ("low", "medium", "high")
- riskSummary: parágrafo curto sobre os riscos identificados`,
            },
            {
              role: "user",
              content: `Título: ${input.title}\nSetor: ${input.sector ?? "Geral"}\nTipo: ${input.type}\nDescrição: ${input.description}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "compliance_analysis",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  dynamicQuestion: { type: "string" },
                  suggestedDocuments: { type: "array", items: { type: "string" } },
                  documentJustifications: { type: "array", items: { type: "string" } },
                  riskLevel: { type: "string", enum: ["low", "medium", "high"] },
                  riskSummary: { type: "string" },
                },
                required: ["dynamicQuestion", "suggestedDocuments", "documentJustifications", "riskLevel", "riskSummary"],
                additionalProperties: false,
              },
            },
          },
        });
        const analise = JSON.parse(aiResp.choices[0].message.content as string) as Record<string, unknown>;
        // Guardar só DEPOIS do parse: o texto de reserva do catch abaixo não
        // pode virar a análise definitiva daquele anúncio.
        memoriaDoCadastro.guardar(hashDoCadastro, analise);
        return analise;
      } catch {
        return {
          dynamicQuestion: "Quais documentos comprovam que esta oportunidade realmente existe?",
          suggestedDocuments: ["Contrato ou Proposta Comercial", "Certidão de Registro da Empresa", "Carta de Intenção (LOI)"],
          documentJustifications: ["Formaliza a oferta comercial", "Valida a existência legal da empresa", "Demonstra intenção formal de negócio"],
          riskLevel: "medium",
          riskSummary: "Análise preliminar indisponível. Recomendamos anexar documentação básica para aumentar a confiabilidade.",
        };
      }
    }),

  // Sugerir documentos faltantes por tipo de oportunidade
  suggestDocuments: protectedProcedure
    .input(z.object({
      opportunityType: z.enum(["offer", "demand", "investment", "partnership", "distribution", "other"]),
      sector: z.string().optional(),
      existingDocuments: z.array(z.string()).default([]),
    }))
    .query(async ({ input }) => {
      // Mesmo tipo, mesmo setor e o mesmo CONJUNTO de documentos já enviados:
      // a lista sugerida tem de ser a mesma, e não outra a cada carregamento da
      // tela.
      const documentosJaEnviados = conjuntoDeDocumentos(input.existingDocuments);
      const hashDaSugestao = hashDoConteudoAnalisado("documentos", {
        tipo: input.opportunityType,
        setor: input.sector,
        documentos: documentosJaEnviados,
      });
      const jaSugerido = memoriaDeDocumentosSugeridos.ler(hashDaSugestao);
      if (jaSugerido) return jaSugerido;

      try {
        const aiResp = await invokeLLM({
          // Temperatura 0: a lista de documentos de um setor não muda de uma
          // consulta para a outra.
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `Você é o sistema de compliance da MarquesaMatch. Sugira documentos necessários para validar uma oportunidade de negócio.\nRetorne JSON com:\n- suggestions: lista de até 6 documentos recomendados\n- priority: lista de prioridades correspondentes ("essential", "recommended", "optional")\n- reason: explicação breve de por que cada documento é importante`,
            },
            {
              role: "user",
              // O mesmo conjunto que entrou no hash vai ao prompt.
              content: `Tipo: ${input.opportunityType}\nSetor: ${input.sector ?? "geral"}\nDocumentos já enviados: ${documentosJaEnviados.join(", ") || "nenhum"}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "document_suggestions",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  suggestions: { type: "array", items: { type: "string" } },
                  priority: { type: "array", items: { type: "string", enum: ["essential", "recommended", "optional"] } },
                  reason: { type: "array", items: { type: "string" } },
                },
                required: ["suggestions", "priority", "reason"],
                additionalProperties: false,
              },
            },
          },
        });
        const sugestao = JSON.parse(aiResp.choices[0].message.content as string) as Record<string, unknown>;
        // Só o que deu certo fica guardado (a reserva do catch, não).
        memoriaDeDocumentosSugeridos.guardar(hashDaSugestao, sugestao);
        return sugestao;
      } catch {
        return {
          suggestions: ["Contrato ou Proposta Comercial", "Certidão de Registro da Empresa", "Comprovante de Capacidade Financeira"],
          priority: ["essential", "essential", "recommended"],
          reason: ["Formaliza a oferta", "Valida a existência legal da empresa", "Demonstra capacidade de execução"],
        };
      }
    }),

  // Minhas oportunidades publicadas
  myOpportunities: protectedProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    const { opportunities } = await import("../../drizzle/schema");
    return db.select().from(opportunities)
      .where(eq(opportunities.publishedBy, ctx.user.id))
      .orderBy(desc(opportunities.createdAt));
  }),

  // Upload de documento para oportunidade
  uploadDocument: protectedProcedure
    .input(z.object({
      opportunityId: z.number().int(),
      name: z.string().min(1).max(300),
      fileKey: z.string().min(1),
      fileUrl: z.string().min(1),
      mimeType: z.string().optional(),
      fileSize: z.number().int().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      const { opportunities, opportunityDocuments } = await import("../../drizzle/schema");
      const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, input.opportunityId)).limit(1);
      if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Oportunidade não encontrada" });
      if (opp.publishedBy !== ctx.user.id && !['admin', 'president', 'gold'].includes(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas quem criou a oportunidade pode adicionar documentos" });
      }
      const [doc] = await db.insert(opportunityDocuments).values({
        opportunityId: input.opportunityId,
        uploadedBy: ctx.user.id,
        name: input.name,
        fileKey: input.fileKey,
        url: input.fileUrl,
        mimeType: input.mimeType,
        sizeBytes: input.fileSize,
      }).$returningId();
      // Recalcular compliance após novo documento (best-effort)
      try {
        const docs = await db.select().from(opportunityDocuments).where(eq(opportunityDocuments.opportunityId, input.opportunityId));
        // O mesmo conjunto vai ao hash E ao prompt: assim o que foi analisado é
        // exatamente o que a memória diz ter analisado. O documento acabou de
        // ser gravado logo acima, então esta lista já o inclui — e reenviar o
        // mesmo arquivo deixa o conjunto igual, sem pagar outra ida ao modelo
        // (ver "A MESMA OPORTUNIDADE, A MESMA NOTA" no topo do arquivo).
        const nomesDosDocumentos = conjuntoDeDocumentos(docs.map(d => d.name));
        const docNames = nomesDosDocumentos.join(", ");
        const hashDaReanalise = hashDoConteudoAnalisado("reanalise", {
          titulo: opp.title,
          descricao: opp.description,
          tipo: opp.type,
          setor: opp.sector,
          pais: opp.country,
          documentos: nomesDosDocumentos,
        });
        let reanalise = memoriaDeCompliance.ler(hashDaReanalise);

        if (!reanalise) {
          const aiResp = await invokeLLM({
            // Temperatura 0 pelo mesmo motivo da análise de criação: a nota é
            // classificação, e sem ela o mesmo par (oportunidade, documentos)
            // saía com nota diferente a cada envio.
            temperature: 0,
            messages: [
              { role: "system", content: `Você é a IA de Compliance e Due Diligence do ecossistema global MarquesaMatch. Reclassifique a oportunidade considerando os documentos enviados. Retorne JSON com: complianceLevel ("green"/"yellow"/"orange"/"red"), riskAnalysis (parágrafo curto sobre riscos), explanation (justificativa do nível de confiança), trustScore (0-100).` },
              { role: "user", content: `Título: ${opp.title}\nDescrição: ${opp.description}\nDocumentos enviados: ${docNames || 'nenhum'}` },
            ],
            response_format: { type: "json_schema", json_schema: { name: "reanalysis", strict: true, schema: { type: "object", properties: { complianceLevel: { type: "string", enum: ["green","yellow","orange","red"] }, riskAnalysis: { type: "string" }, explanation: { type: "string" }, trustScore: { type: "number" } }, required: ["complianceLevel","riskAnalysis","explanation","trustScore"], additionalProperties: false } } },
          });
          const r = JSON.parse(aiResp.choices[0].message.content as string);
          reanalise = {
            nivel: r.complianceLevel,
            explicacao: explicacaoCombinada(r),
            // A reanálise não sugere documentos: os da criação continuam
            // valendo na coluna suggestedDocuments, que este caminho não toca.
            documentosSugeridos: [],
            nota: r.trustScore,
          };
          // Depois do parse: reanálise que estourou não é guardada, e o próximo
          // envio do mesmo documento tenta de novo.
          memoriaDeCompliance.guardar(hashDaReanalise, reanalise);
        }

        await db.update(opportunities).set({
          frauenTrustScore: reanalise.nota,
          complianceLevel: reanalise.nivel as any,
          complianceExplanation: reanalise.explicacao,
          lastComplianceAt: new Date(),
        }).where(eq(opportunities.id, input.opportunityId));

        // Alerta de subida de nível de confiabilidade
        const levelOrder = { red: 0, orange: 1, yellow: 2, green: 3 };
        const oldLevel = (opp.complianceLevel ?? 'red') as string;
        const newLevel = reanalise.nivel as string;
        const oldRank = levelOrder[oldLevel as keyof typeof levelOrder] ?? 0;
        const newRank = levelOrder[newLevel as keyof typeof levelOrder] ?? 0;
        if (newRank > oldRank) {
          const levelLabels: Record<string, string> = {
            red: '🔴 Baixa Confiabilidade',
            orange: '🟠 Necessita Validação',
            yellow: '🟡 Confiabilidade Média',
            green: '🟢 Alta Confiabilidade',
          };
          const scoreMsg = `Nota de confiança: ${Math.round(reanalise.nota)}%`;
          await createNotification({
            userId: opp.publishedBy,
            type: 'compliance_update',
            title: `⬆️ Sua oportunidade subiu de nível!`,
            body: `"${opp.title}" passou de ${levelLabels[oldLevel] ?? oldLevel} para ${levelLabels[newLevel] ?? newLevel}. ${scoreMsg}`,
            actionUrl: `/opportunities/${input.opportunityId}`,
          });
        }
      } catch { /* compliance recalc is best-effort */ }
      await createAuditLog({ userId: ctx.user.id, action: "DOCUMENT_UPLOAD", resource: "opportunity_documents", resourceId: String(doc.id), status: "success", riskLevel: "low" });
      return { success: true, documentId: doc.id };
    }),

  // Remover oportunidade indesejada — apenas Ouro
  deleteOpportunity: goldProcedure
    .input(z.object({
      opportunityId: z.number().int(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      const { opportunities } = await import("../../drizzle/schema");
      // Verificar se a oportunidade existe
      const [opp] = await db.select({ id: opportunities.id, title: opportunities.title, publishedBy: opportunities.publishedBy })
        .from(opportunities).where(eq(opportunities.id, input.opportunityId)).limit(1);
      if (!opp) throw new TRPCError({ code: "NOT_FOUND" });
      // Marcar como removida ao invés de deletar fisicamente
      await db.update(opportunities)
        .set({ status: "removed" })
        .where(eq(opportunities.id, input.opportunityId));
      await createAuditLog({
        userId: ctx.user.id,
        action: "GOLD_REMOVE_OPPORTUNITY",
        resource: "opportunities",
        resourceId: String(input.opportunityId),
        details: { reason: input.reason, opportunityTitle: opp.title },
        status: "success",
        riskLevel: "medium",
      });
      return { success: true };
    }),

  // Matches de oportunidades (IA conecta complementares) — apenas Ouro
  matches: goldProcedure
    .input(z.object({ opportunityId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await exigirDb();
      const { opportunities } = await import("../../drizzle/schema");
      return db.select({
        match: opportunityMatches,
        opportunity: opportunities,
      })
        .from(opportunityMatches)
        .innerJoin(opportunities, eq(opportunities.id, opportunityMatches.opportunityBId))
        .where(eq(opportunityMatches.opportunityAId, input.opportunityId))
        .orderBy(desc(opportunityMatches.score))
        .limit(10);
    }),
});
