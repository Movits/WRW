import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { exigirDb, createNotification } from "../db";
import { opportunities, platformNotifications, userProfiles, users } from "../../drizzle/schema";
import { usersComConsentimento } from "./consent";
import { insightParaExibir } from "../vocabulario-da-conexao";
import {
  DESCRICAO_NA_RECOMENDACAO, PROPRIEDADES_DO_PORTAO, REGRA_DA_DEMANDA_EXPRESSA,
  cortarEmPalavra, descreverDemandasParaIA, necessidadesEscritasDoPerfil, passaNoPortao, rotularBuscas, textoEscritoPelaPessoa,
} from "../portao-da-demanda-expressa";

// ============================================================
// MOTOR DE IA DE MATCHMAKING SEMÂNTICO
// ============================================================
export const matchingRouter = router({
  // Retorna oportunidades recomendadas para o usuário logado com score de compatibilidade
  getRecommendedOpportunities: protectedProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();

    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, ctx.user.id)).limit(1);
    if (!profile) return [];

    // A mesma régua de opportunities.list: confidencial é só para Ouro+. Este
    // era o segundo caminho de consulta que tinha esquecido o filtro — e
    // devolvia a oportunidade INTEIRA (título, descrição, tags) para qualquer
    // logada, além de mandá-la ao LLM. Exatamente o modo de falha que a regra
    // geral de privacidade.md descreve.
    const isGold = ctx.user.role === "gold" || ctx.user.role === "admin" || ctx.user.role === "president";
    const activeOpps = await db
      .select()
      .from(opportunities)
      .where(and(
        eq(opportunities.status, "active"),
        sql`${opportunities.publishedBy} != ${ctx.user.id}`,
        ...(isGold ? [] : [eq(opportunities.isConfidential, false)]),
      ))
      .orderBy(desc(opportunities.createdAt))
      .limit(50);

    if (activeOpps.length === 0) return [];

    const userContext = [
      profile.bio ? `Bio: ${profile.bio}` : "",
      profile.activityArea ? `Área de atuação: ${profile.activityArea}` : "",
      profile.primarySpecialty ? `Especialidade: ${profile.primarySpecialty}` : "",
      profile.sector ? `Setor: ${profile.sector}` : "",
      profile.whatIHave ? `O que tenho: ${JSON.stringify(profile.whatIHave)}` : "",
      // "O que preciso" leva também o texto de "Outra necessidade": é necessidade declarada (14/09).
      necessidadesEscritasDoPerfil(profile).length ? `O que preciso: ${JSON.stringify(necessidadesEscritasDoPerfil(profile))}` : "",
      // A segunda camada de "O que preciso" (14/09): cada demanda com a categoria e os qualificadores
      // rotulados. A descrição já foi em "O que preciso" (a de Compradores não: é o que ela vende); setor,
      // país e região só qualificam (regra 5).
      descreverDemandasParaIA(profile) ? `Demandas detalhadas:\n${descreverDemandasParaIA(profile)}` : "",
      // As buscas vão pelo rótulo, com "Serviço Especializado" marcada como genérica (a regra 5 do prompt).
      rotularBuscas(profile.seekingTypes) ? `Buscando: ${rotularBuscas(profile.seekingTypes)}` : "",
      profile.interestSectors ? `Setores de interesse: ${JSON.stringify(profile.interestSectors)}` : "",
      profile.country ? `País: ${profile.country}` : "",
    ].filter(Boolean).join("\n");

    // Uma linha por oportunidade. A descrição vai cortada (o prompt carrega
    // até 50 delas), mas em DESCRICAO_NA_RECOMENDACAO caracteres e em
    // fronteira de palavra, não nos 200 de antes: com o portão, a necessidade
    // declarada precisa CABER no que o modelo vê, senão o serviço legítimo
    // nunca casa.
    const descricaoCortada = activeOpps.map(opp => cortarEmPalavra(opp.description || "", DESCRICAO_NA_RECOMENDACAO));
    const contextoPorOportunidade = activeOpps.map((opp, i) =>
      `[${i}] ID:${opp.id} Título:"${opp.title}" Setor:${opp.sector || "N/A"} Tipo:${opp.type} Tags:${JSON.stringify(opp.tags || [])} Descrição:"${descricaoCortada[i]}"`
    );
    // O que a PESSOA escreveu (título, tags, a mesma descrição cortada): é
    // contra isto, e não contra a linha inteira com "Setor:" e "Tipo:", que a
    // citação da necessidade expressa é conferida.
    const textoDaOportunidade = activeOpps.map((opp, i) => textoEscritoPelaPessoa(opp.title, opp.tags, descricaoCortada[i]));
    const oppsContext = contextoPorOportunidade.join("\n");
    const perfilNoPortao = {
      whatIHave: profile.whatIHave, whatINeed: profile.whatINeed, whatINeedDetails: profile.whatINeedDetails,
      seekingTypes: profile.seekingTypes, seekingOtherNeed: profile.seekingOtherNeed, lookingForInvestment: profile.lookingForInvestment,
      activityArea: profile.activityArea, primarySpecialty: profile.primarySpecialty,
    };

    const aiResp = await invokeLLM({
      messages: [
        {
          role: "system",
          // "Necessidades implícitas" saiu do pedido de propósito: era a
          // instrução que fazia um serviço casar com toda empresa que "poderia
          // precisar" dele. A regra da demanda expressa é o contrário disso, e
          // vale só para serviço — os outros tipos seguem com sinônimos e
          // setores relacionados.
          content: `Você é o motor semântico de recomendação da plataforma MarquesaMatch. Analise o perfil da usuária e as oportunidades disponíveis. Retorne um JSON com os índices das oportunidades mais compatíveis e o score de compatibilidade (0-100) para cada uma. Para produtos, ativos, investimento, conexões, tecnologia e imóveis, considere sinônimos, setores relacionados e a sinergia entre "O que tenho" e "O que preciso". Retorne apenas as oportunidades com score >= 40. Máximo de 10 resultados. A usuária lê o "reason": nele (e só nele) nunca use a palavra "match"; se precisar nomear a sugestão, diga "conexão sugerida"; "compatibilidade" continua "compatibilidade". Isso não muda "tipoDaOferta": "conexao" continua sendo só o item que oferece contatos/networking.

${REGRA_DA_DEMANDA_EXPRESSA}`,
        },
        {
          role: "user",
          content: `PERFIL DA USUÁRIA:\n${userContext}\n\nOPORTUNIDADES DISPONÍVEIS (descrições podem estar cortadas em ${DESCRICAO_NA_RECOMENDACAO} caracteres; não complete o texto):\n${oppsContext}\n\nRetorne JSON no formato: {"matches": [{"index": 0, "score": 95, "reason": "Explicação curta em português", "tipoDaOferta": "servico | produto | ativo | oportunidade | investimento | conexao | tecnologia | imovel | outros | nenhuma", "necessidadeExpressa": "trecho literal da oportunidade que declara a necessidade (só quando tipoDaOferta for servico; senão vazio)"}]}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "matchmaking_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              matches: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    index: { type: "integer" },
                    score: { type: "integer" },
                    reason: { type: "string" },
                    ...PROPRIEDADES_DO_PORTAO,
                  },
                  required: ["index", "score", "reason", "tipoDaOferta", "necessidadeExpressa"],
                  additionalProperties: false,
                },
              },
            },
            required: ["matches"],
            additionalProperties: false,
          },
        },
      },
    });

    const rawContent = aiResp.choices[0]?.message?.content;
    const content = typeof rawContent === "string" ? rawContent : "{}";
    let parsed: { matches: { index: number; score: number; reason: string; tipoDaOferta?: string; necessidadeExpressa?: string }[] } = { matches: [] };
    try { parsed = JSON.parse(content); } catch { parsed = { matches: [] }; }

    return parsed.matches
      .filter((m) => m.index >= 0 && m.index < activeOpps.length && m.score >= 40)
      // O portão: match apoiado em SERVIÇO só entra com a necessidade expressa
      // citada e conferida no texto da própria oportunidade — a nota não
      // importa. Prompt é pedido; isto é a garantia.
      .filter((m) => {
        const passa = passaNoPortao(m, textoDaOportunidade[m.index], perfilNoPortao, activeOpps[m.index]);
        if (!passa) console.info(`[Match] Oportunidade ${activeOpps[m.index].id} fora da recomendação: serviço sem necessidade expressa.`);
        return passa;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((m) => ({
        ...activeOpps[m.index],
        compatibilityScore: m.score,
        // O prompt pede "conexão sugerida"; o que ainda disser "match" não vai à tela.
        compatibilityReason: insightParaExibir(m.reason) ?? "",
      }));
  }),
  // `checkAndNotifyHighCompatibility` saiu daqui (15/09): era um protectedProcedure
  // sem checagem nenhuma de quem pedia, e qualquer conta logada, até Bronze, podia
  // chamá-lo em laço para a oportunidade de outra pessoa. Cada chamada lia 200
  // perfis, mandava todos ao LLM e repetia as notificações. Nenhuma tela o chamava:
  // o único gatilho legítimo é a aprovação da moderação (president.validateOpportunity),
  // que chama a função abaixo direto no servidor.
});

// Fora do router para a aprovação da moderação também disparar os alertas: a
// versão anterior só rodava no create, condicionada a status "active" — que o
// create nunca produz (toda oportunidade nasce "pending").
export async function notifyHighCompatibilityForOpportunity(opportunityId: number) {
  {
      const db = await exigirDb();

      const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId)).limit(1);
      if (!opp || opp.status !== "active") return { notified: 0 };

      const todos = await db
        .select({
          userId: userProfiles.userId,
          role: users.role,
          whatIHave: userProfiles.whatIHave,
          whatINeed: userProfiles.whatINeed,
          // A descrição das demandas detalhadas vai em "preciso" e ao portão, como "Outra necessidade".
          whatINeedDetails: userProfiles.whatINeedDetails,
          sector: userProfiles.sector,
          seekingTypes: userProfiles.seekingTypes,
          // O texto de "Outra necessidade" é necessidade declarada: vai ao prompt em "preciso" e ao portão.
          seekingOtherNeed: userProfiles.seekingOtherNeed,
          interestSectors: userProfiles.interestSectors,
          activityArea: userProfiles.activityArea,
          // Lidos só pelo portão (base expressa fora do serviço, e o piso quando
          // "O que tenho" está vazio); não vão ao prompt.
          lookingForInvestment: userProfiles.lookingForInvestment,
          primarySpecialty: userProfiles.primarySpecialty,
        })
        .from(userProfiles)
        .innerJoin(users, eq(users.id, userProfiles.userId))
        .where(sql`${userProfiles.userId} != ${opp.publishedBy}`)
        .limit(200);

      // Oportunidade confidencial é assunto de Ouro: o alerta não pode contar
      // o título dela (nem mandar o contexto ao LLM em nome) de quem não tem o
      // nível — mesma régua do filtro de opportunities.list.
      const podeVerConfidencial = (role: string | null) => role === "gold" || role === "president" || role === "admin";
      const elegiveis = opp.isConfidential ? todos.filter(perfil => podeVerConfidencial(perfil.role)) : todos;

      // Etapa 11: o alerta cruza "tenho/preciso" dos perfis com a oportunidade
      // e manda tudo ao LLM — isso é cruzamento, e dado de quem não aceitou o
      // termo não entra nem no prompt.
      const comTermo = await usersComConsentimento(elegiveis.map(perfil => perfil.userId), "termo_smart_match");
      const autorizadas = elegiveis.filter(perfil => comTermo.has(perfil.userId));
      // Ninguém autorizado = ninguém para alertar. Chamar o LLM com a lista
      // vazia seria um no-op garantido queimando uma chamada da cota do dia.
      if (!autorizadas.length) return { notified: 0 };

      // Um alerta por (usuária, oportunidade). A moderação pode aprovar a mesma
      // oportunidade de novo (voltou a "pending" e foi reaprovada, ou a
      // presidência clicou duas vezes), e cada aprovação repetia o aviso para as
      // mesmas pessoas. Quem já tem o aviso desta oportunidade sai ANTES do LLM:
      // não recebe outro e não gasta cota. O vínculo é o actionUrl, o mesmo que
      // exclusao-de-conta.ts usa para apagar os avisos de oportunidade removida.
      const actionUrl = `/opportunities/${opp.id}`;
      const jaAvisadas = await db
        .select({ userId: platformNotifications.userId })
        .from(platformNotifications)
        .where(and(
          eq(platformNotifications.type, "new_match"),
          eq(platformNotifications.actionUrl, actionUrl),
          inArray(platformNotifications.userId, autorizadas.map(perfil => perfil.userId)),
        ));
      const idsJaAvisadas = new Set(jaAvisadas.map(linha => linha.userId));
      const profiles = autorizadas.filter(perfil => !idsJaAvisadas.has(perfil.userId));
      if (!profiles.length) return { notified: 0 };

      // A descrição vai INTEIRA (é uma oportunidade só): com o portão, a
      // necessidade declarada precisa caber no que o modelo vê; os 300
      // caracteres de antes escondiam o resto de uma descrição de até 5000.
      const oppContext = `Título: "${opp.title}" | Setor: ${opp.sector || "N/A"} | Tipo: ${opp.type} | Tags: ${JSON.stringify(opp.tags || [])} | Descrição: "${opp.description || ""}"`;
      // Só o que a pessoa escreveu vale como fonte da citação (setor e tipo não são necessidade).
      const textoDaOportunidade = textoEscritoPelaPessoa(opp.title, opp.tags, opp.description);
      // "tenho" entra junto com "preciso": uma oportunidade que BUSCA algo casa
      // com quem OFERECE esse algo. Antes só "preciso" ia ao alerta, então quem
      // poderia suprir a oportunidade nunca era avisada — metade do cruzamento.
      const profilesContext = profiles.map((p, i) =>
        `[${i}] userId:${p.userId} setor:${p.sector || "N/A"} tenho:${JSON.stringify(p.whatIHave || [])} preciso:${JSON.stringify(necessidadesEscritasDoPerfil(p))} busca:${JSON.stringify(rotularBuscas(p.seekingTypes))} interesse:${JSON.stringify(p.interestSectors || [])}`
      ).join("\n");

      const aiResp = await invokeLLM({
        messages: [
          {
            role: "system",
            // A mesma regra da recomendação: o "tenho" de um perfil que é
            // serviço só rende alerta se a oportunidade DECLARA precisar dele.
            content: `Você é o motor de alertas da MarquesaMatch. Analise uma oportunidade e os perfis de usuárias para identificar quem tem alta compatibilidade (>= 80%). Retorne apenas os índices dos perfis compatíveis com score >= 80.

${REGRA_DA_DEMANDA_EXPRESSA}`,
          },
          { role: "user", content: `OPORTUNIDADE:\n${oppContext}\n\nPERFIS:\n${profilesContext}\n\nRetorne JSON: {"alerts": [{"index": 0, "score": 85, "tipoDaOferta": "servico | produto | ativo | oportunidade | investimento | conexao | tecnologia | imovel | outros | nenhuma", "necessidadeExpressa": "trecho literal da oportunidade que declara a necessidade (só quando tipoDaOferta for servico; senão vazio)"}]}` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "alert_result",
            strict: true,
            schema: {
              type: "object",
              properties: {
                alerts: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { index: { type: "integer" }, score: { type: "integer" }, ...PROPRIEDADES_DO_PORTAO },
                    required: ["index", "score", "tipoDaOferta", "necessidadeExpressa"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["alerts"],
              additionalProperties: false,
            },
          },
        },
      });

      const rawContent2 = aiResp.choices[0]?.message?.content;
      const content = typeof rawContent2 === "string" ? rawContent2 : "{}";
      let parsed: { alerts: { index: number; score: number; tipoDaOferta?: string; necessidadeExpressa?: string }[] } = { alerts: [] };
      try { parsed = JSON.parse(content); } catch { parsed = { alerts: [] }; }

      let notified = 0;
      for (const alert of parsed.alerts) {
        if (alert.index < 0 || alert.index >= profiles.length || alert.score < 80) continue;
        // O portão no alerta: serviço só avisa com a necessidade expressa
        // citada e conferida no texto da oportunidade que o modelo recebeu.
        if (!passaNoPortao(alert, textoDaOportunidade, profiles[alert.index], opp)) {
          console.info(`[Match] Alerta da oportunidade ${opp.id} retido para o perfil ${profiles[alert.index].userId}: serviço sem necessidade expressa.`);
          continue;
        }
        const targetUserId = profiles[alert.index].userId;
        await createNotification({
          userId: targetUserId,
          type: "new_match",
          title: `⚡ Nova oportunidade ${alert.score}% compatível com você!`,
          body: `"${opp.title}" foi publicada e tem alta compatibilidade com seu perfil. Confira agora!`,
          actionUrl,
          isRead: false,
        });
        notified++;
      }
      return { notified };
  }
}
