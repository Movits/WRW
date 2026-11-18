import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { CADASTRO_EMPRESARIAL_MAX, exigeCadastroEmpresarial, normalizarCadastroEmpresarial } from "../../shared/business-registration";
import { exigirDb, getUserProfile, upsertUserProfile } from "../db";
import { cargoEEmpresaParaGravar } from "../perfil-consolidado";
import { users, userProfiles } from "../../drizzle/schema";
import { toPublicUser } from "../auth";
import { reavaliarNivelPeloPerfil } from "../nivel-do-perfil";
import { exigirAceiteDoTermoGeral } from "../termo-geral-de-uso";
import { exigirDeclaracaoDeMaioridade, registrarDeclaracaoDeMaioridade } from "../maioridade";
import { IDADE_MINIMA, MENSAGEM_IDADE_ABAIXO_DO_MINIMO } from "../../shared/maioridade";
import { getRequestIp } from "../password-reset-security";
import {
  LIMITE_OUTRA_NECESSIDADE,
  outraNecessidadeValida,
  textoDaOutraNecessidade,
  VALORES_ACEITOS_EM_SEEKING_TYPES,
} from "../../shared/o-que-busca";
import { esquemaDasDemandas, esquemaDoWhatINeed, prepararOQuePreciso } from "../o-que-preciso";
import { cortarSemPartirEmoji, LIMITE_DA_BIO_GRAVADA, LIMITE_DA_BIO_NO_CADASTRO } from "../../shared/apresentacao";
import { LIMITE_DO_QUE_TENHO } from "../../shared/reuniao-no-match";

// ============================================================
// PERFIL DO USUÁRIO
// ============================================================

/**
 * A apresentação GRAVADA que o cadastro não deve regravar por cima: quando o
 * texto que chegou é o corte que o formulário fazia (bundle antigo em cache) ou
 * está VAZIO com apresentação gravada (o bundle publicado da main). Devolve null
 * em todo o resto — bio ausente, texto editado, conta sem apresentação —, e aí
 * a escrita segue normal.
 *
 * A comparação é por IGUALDADE com `cortarSemPartirEmoji`, a mesma função da
 * tela, e não por "começa com": um começo com folga descarta edição legítima
 * — quem apaga o pedaço pendurado no fim do texto cortado está editando, e
 * essa edição tem de valer.
 */
async function apresentacaoAPreservar(userId: number, bioRecebida: string | undefined): Promise<string | null> {
  if (bioRecebida === undefined) return null;
  // Um corte tem o tamanho do teto, ou um a menos quando o último code point
  // ocupa duas unidades UTF-16 e não coube. Texto de tamanho médio não é
  // corte nem apagamento, e nem consulta o perfil.
  const podeSerCorte = bioRecebida.length >= LIMITE_DA_BIO_NO_CADASTRO - 1;
  if (!podeSerCorte && bioRecebida.trim() !== "") return null;
  const perfil = (await getUserProfile(userId)) as { bio?: string | null } | null;
  const salva = perfil?.bio ?? "";
  // Bio VAZIA com apresentação gravada: é o bundle publicado da main, que
  // manda `bio` sempre e nunca pré-preenche o campo. Concluir o cadastro não
  // é o lugar de apagar uma apresentação que a pessoa não viu — quem quer
  // limpar o texto faz isso no Perfil, onde ele está à vista.
  if (bioRecebida.trim() === "") return salva.length > 0 ? salva : null;
  if (salva.length <= LIMITE_DA_BIO_NO_CADASTRO) return null;
  // O bundle antigo manda `form.bio.trim()`: o corte pode chegar sem os espaços
  // das pontas, e a igualdade tem de reconhecer as duas formas.
  const corte = cortarSemPartirEmoji(salva, LIMITE_DA_BIO_NO_CADASTRO);
  return bioRecebida === corte || bioRecebida === corte.trim() ? salva : null;
}

// Aceita "meusite.com.br" e completa o protocolo. Antes, z.string().url()
// puro rejeitava a mutation INTEIRA quando a usuária colava a URL sem
// https:// — nenhum campo era salvo e o erro saía como zod cru.
const urlFlexivel = z.preprocess(
  v => (typeof v === "string" && v.trim() && !/^https?:\/\//i.test(v.trim()) ? "https://" + v.trim() : v),
  z.string().url("Informe uma URL válida (ex.: https://seusite.com.br)").optional().or(z.literal(""))
);

// O campo `companyCnpj` guarda o Número de Cadastro Empresarial (Rosber, 14/09
// 20:44; comportamento da PR #133 do Gabriel): letras e números, sem máscara,
// sem 14 dígitos fixos e sem dígito verificador (vale para registro de outro
// país e para o CNPJ alfanumérico). Quem se declara MEI, pessoa jurídica ou
// organização sem fins lucrativos tem cadastro por definição (A7).
// Os dois tetos ficam aqui, e não num .max() do zod: erro do zod chega ao toast do
// Onboarding como JSON cru e em inglês, e a tela não corta mais o que se cola.
const CADASTRO_BRUTO_MAX = 1000;
const MENSAGEM_CADASTRO_LONGO = `O Número de Cadastro Empresarial tem no máximo ${CADASTRO_EMPRESARIAL_MAX} letras e números.`;

function conferirCadastroEmpresarial(personType: string | undefined, companyCnpj: string | undefined) {
  if (companyCnpj && companyCnpj.length > CADASTRO_BRUTO_MAX) {
    throw new TRPCError({ code: "BAD_REQUEST", message: MENSAGEM_CADASTRO_LONGO });
  }
  const cadastro = companyCnpj ? normalizarCadastroEmpresarial(companyCnpj) : "";
  if (cadastro.length > CADASTRO_EMPRESARIAL_MAX) {
    throw new TRPCError({ code: "BAD_REQUEST", message: MENSAGEM_CADASTRO_LONGO });
  }
  if (exigeCadastroEmpresarial(personType) && !cadastro) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Informe o Número de Cadastro Empresarial: ele é obrigatório para MEI, pessoa jurídica e organização sem fins lucrativos." });
  }
}

/**
 * "O que tenho": as opções marcadas e, desde 15/09 (Rosber, 14/09 21:17), o ativo
 * escrito à mão em "Outros" — que chega aqui como MAIS UM item da lista, não como
 * campo próprio, porque é assim que os motores leem os ativos. Os tetos são de
 * produto, para um texto livre não virar um item enorme numa coluna json; a tela
 * já corta em 200. Nada aqui recusa dado antigo: os ids gravados têm 25 letras
 * no máximo e as listas, 11 itens. O teto de itens é o mesmo da confirmação que
 * a reunião leva ao perfil (N5, LIMITE_DO_QUE_TENHO).
 */
const esquemaDoWhatIHave = z.array(z.string().max(500)).max(LIMITE_DO_QUE_TENHO);

export const profileRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const profile = await getUserProfile(ctx.user.id);
    return { user: toPublicUser(ctx.user), profile };
  }),

 update: protectedProcedure
   .input(z.object({
     displayName: z.string().min(2).max(100).optional(),
     // O Perfil edita o que JÁ ESTÁ gravado, e a carga da planilha grava mais
     // do que o formulário do cadastro mostra: com o teto do cadastro aqui, a
     // mutation inteira era recusada e a pessoa não conseguia nem encurtar.
     bio: z.string().max(LIMITE_DA_BIO_GRAVADA).optional(),
     city: z.string().max(100).optional(),
     country: z.string().length(2).optional(),
     sectors: z.array(z.string()).optional(),
     languages: z.array(z.string()).optional(),
     linkedinUrl: urlFlexivel,
     websiteUrl: urlFlexivel,
     avatarUrl: z.string().optional(),
     company: z.string().max(200).optional(),
     position: z.string().max(200).optional(),
     personType: z.enum(["individual", "legal_entity", "mei", "nonprofit"]).optional(),
     companySize: z.enum(["mei", "micro", "small", "medium", "large"]).optional(),
     companyCnpj: z.string().optional(),
     gender: z.enum(["male", "female", "prefer_not_to_say"]).optional(),
     shortTermGoal: z.string().max(2000).optional(),
     longTermGoal: z.string().max(2000).optional(),
     // Novos campos v2
     jobTitle: z.string().max(200).optional(),
     activityArea: z.string().max(200).optional(),
     interestSectors: z.array(z.string()).optional(),
     institutionalNetwork: z.string().max(300).optional(),
      currentResources: z.string().max(2000).optional(),
     whatIHave: esquemaDoWhatIHave.optional(),
      whatINeed: esquemaDoWhatINeed.optional(),
      // "O que preciso" detalhado (shared/o-que-preciso.ts); validado em prepararOQuePreciso.
      whatINeedDetails: esquemaDasDemandas.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      conferirCadastroEmpresarial(input.personType, input.companyCnpj);
      // Demanda começada e inválida é recusada antes de gravar qualquer coisa.
      const oQuePreciso = prepararOQuePreciso(input.whatINeed, input.whatINeedDetails);
      // `position` é coluna de users, não de user_profiles — mandá-la ao
      // upsert derrubava o UPDATE inteiro com "Unknown column".
      const { position: _position, whatINeed: _whatINeed, whatINeedDetails: _whatINeedDetails, ...semOQuePreciso } = input;
      const updateData = { ...semOQuePreciso, ...oQuePreciso };
      // A leitura cai em currentRole/currentCompany quando jobTitle/company está
      // vazio (perfil-consolidado.ts). Sem anular a coluna antiga do par que
      // chegou, apagar cargo ou empresa no Perfil não apagava: o valor antigo
      // voltava para quem fez o Onboarding antes da consolidação e para as contas
      // da carga, que o importador grava nas duas colunas. Só anula, não copia;
      // um par por vez, para quem manda só o cargo não perder a empresa antiga.
      const legado = {
        ...(input.jobTitle !== undefined ? { currentRole: null } : {}),
        ...(input.company !== undefined ? { currentCompany: null } : {}),
      };
      const businessData = updateData.personType === "individual"
        ? { ...updateData, ...legado, companySize: null, companyCnpj: null }
        : { ...updateData, ...legado, companyCnpj: updateData.companyCnpj ? normalizarCadastroEmpresarial(updateData.companyCnpj) || undefined : undefined };
      await upsertUserProfile(ctx.user.id, businessData);
      // Atualizar company/position na tabela users também
      const db = await exigirDb();
      if (input.company !== undefined || input.position !== undefined) {
        const updateData: any = {};
        if (input.company !== undefined) updateData.company = input.company;
        if (input.position !== undefined) updateData.position = input.position;
        if (input.country !== undefined) updateData.country = input.country;
        await db.update(users).set(updateData).where(eq(users.id, ctx.user.id));
      }
      // Governança: Bronze vira Prata quando o perfil salvo atende à régua de
      // qualidade (shared/qualificacao-do-perfil.ts). Nunca rebaixa ninguém.
      const { promovidaAPrata } = await reavaliarNivelPeloPerfil(ctx.user);
      return { success: true, promovidaAPrata };
    }),

 completeOnboarding: protectedProcedure
   .input(z.object({
     displayName: z.string().min(2).max(100),
     // O campo mostra a apresentação inteira, inclusive a da carga, que passa
     // do teto do cadastro: com o teto menor aqui, concluir devolveria o texto
     // gravado e o zod derrubaria a mutation inteira.
     bio: z.string().max(LIMITE_DA_BIO_GRAVADA).optional(),
     city: z.string().max(100),
     country: z.string().length(2).default("BR"),
     sectors: z.array(z.string()).min(1).max(5).optional(),
     // `.default([])` gravava uma lista VAZIA quando o pedido não trazia o
     // campo. Os idiomas saíram do cadastro (Rosber, 14/09 21:08) e, com o
     // default, concluir o cadastro apagaria os idiomas já gravados — o
     // contrário do combinado ("o servidor continua aceitando, o dado antigo
     // fica"). Ausente agora é ausente: o upsert não toca na coluna.
     languages: z.array(z.string()).optional(),
     linkedinUrl: z.string().optional(),
     company: z.string().max(200).optional(),
     position: z.string().max(200).optional(),
     personType: z.enum(["individual", "legal_entity", "mei", "nonprofit"]).optional(),
     companySize: z.enum(["mei", "micro", "small", "medium", "large"]).optional(),
     companyCnpj: z.string().optional(),
     gender: z.enum(["male", "female", "prefer_not_to_say"]).optional(),
     // Campos do sistema de matching. A tela não pede mais a idade (14/09), mas
     // quem a mandar respeita a cláusula 3.4 do Termo Geral: 18 anos ou mais
     // (era 16; ver shared/maioridade.ts).
     age: z.number().int().min(IDADE_MINIMA, MENSAGEM_IDADE_ABAIXO_DO_MINIMO).max(120).optional(),
     // "Declaro que tenho 18 anos ou mais.", a caixa da última etapa. Só `true`
     // conclui; a recusa, com mensagem em português, é de exigirDeclaracaoDeMaioridade.
     declaraMaioridade: z.boolean().optional(),
     primarySpecialty: z.string().max(100).optional(),
     secondarySpecialties: z.array(z.string().min(1).max(100)).optional(),
     experienceYears: z.number().int().min(0).max(60).optional(),
     educationLevel: z.string().max(50).optional(),
     // Nomes antigos de cargo e empresa: aceitos para o Onboarding em cache
     // durante o deploy, mas gravados em jobTitle/company (ver abaixo).
     currentRole: z.string().max(200).optional(),
     currentCompany: z.string().max(200).optional(),
     sector: z.string().max(100).optional(),
     // "O que você busca?": as 12 chaves de shared/o-que-busca.ts, o "Quero
     // também mentorar" e as 5 antigas (job, mentor, investor, strategic_partner,
     // team). As antigas são COMPATIBILIDADE DE DADO JÁ GRAVADO, não cache de
     // deploy: 14/09 trocou a lista sem migrar perfil, então um perfil antigo
     // devolve essas chaves ao salvar e seria recusado inteiro. Só saem daqui
     // depois de scripts/normalizar-buscas-antigas.mjs rodar com --aplicar.
     seekingTypes: z.array(z.string().refine(
       valor => VALORES_ACEITOS_EM_SEEKING_TYPES.includes(valor),
       "Opção desconhecida em \"O que você busca?\".",
     )).max(20).optional(),
     // Texto obrigatório quando "Outra necessidade" está marcada (validado abaixo).
     seekingOtherNeed: z.string().max(LIMITE_OUTRA_NECESSIDADE).optional(),
     // As metas eram coletadas e descartadas: não havia coluna para elas.
     shortTermGoal: z.string().max(2000).optional(),
     longTermGoal: z.string().max(2000).optional(),
     businessInterests: z.array(z.string()).optional(),
     preferredCompanySize: z.string().max(50).optional(),
     openToRemote: z.boolean().optional(),
     availableForTravel: z.boolean().optional(),
     incomeRange: z.string().max(50).optional(),
     investmentCapacity: z.enum(["none", "under_10k", "10k_50k", "50k_200k", "200k_plus"]).optional(),
     lookingForInvestment: z.boolean().optional(),
     workStyle: z.string().max(50).optional(),
     values: z.array(z.string()).max(4).optional(),
     // Novos campos v2
     jobTitle: z.string().max(200).optional(),
     activityArea: z.string().max(200).optional(),
     interestSectors: z.array(z.string()).optional(),
     institutionalNetwork: z.string().max(300).optional(),
      currentResources: z.string().max(2000).optional(),
     whatIHave: esquemaDoWhatIHave.optional(),
      whatINeed: esquemaDoWhatINeed.optional(),
      // "O que preciso" detalhado (shared/o-que-preciso.ts); ausente no Onboarding em cache do deploy.
      whatINeedDetails: esquemaDasDemandas.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Antes de tudo: sem a declaração de maioridade (cláusula 3.4 do Termo
      // Geral) nada é lido nem gravado e o cadastro não conclui.
      exigirDeclaracaoDeMaioridade(input.declaraMaioridade);
      conferirCadastroEmpresarial(input.personType, input.companyCnpj);
      if (!outraNecessidadeValida(input.seekingTypes, input.seekingOtherNeed)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Você marcou \"Outra necessidade\": descreva o que você procura." });
      }
      // Antes do termo e de qualquer escrita: demanda começada e inválida não grava nada.
      const oQuePreciso = prepararOQuePreciso(input.whatINeed, input.whatINeedDetails);
      // Última etapa do cadastro: sem o Termo Geral de Uso vigente aceito, nada
      // é gravado e o cadastro não conclui (server/termo-geral-de-uso.ts).
      const termoAceito = await exigirAceiteDoTermoGeral(ctx.user.id);
      const { company, position, jobTitle, currentRole, currentCompany, activityArea, interestSectors, institutionalNetwork, currentResources, whatIHave, whatINeed: _whatINeed, whatINeedDetails: _whatINeedDetails, personType, companySize, companyCnpj, seekingOtherNeed, declaraMaioridade: _declaraMaioridade, ...profileData } = input;
      // Concluir o cadastro não regrava o corte que a própria tela mostrou. O
      // formulário corta a bio no teto para caber; a trava de não reenviar
      // esse corte é do cliente, e um bundle antigo em cache durante o deploy
      // volta a mandar o texto cortado — o upsert gravaria por cima e uma bio
      // importada de 1500 caracteres perderia 500, em silêncio e sem
      // histórico da coluna. Só o texto IDÊNTICO ao corte é ignorado:
      // qualquer edição, inclusive apagar o pedaço pendurado no fim do texto
      // cortado, grava normalmente.
      const bioPreservada = await apresentacaoAPreservar(ctx.user.id, input.bio);
      // A prova da declaração de maioridade vem ANTES de qualquer escrita: com
      // IP, user-agent e a versão do Termo Geral aceita (server/maioridade.ts
      // explica por que na auditoria e não no `consents`). Se a linha não
      // grava, a mutation falha aqui e o cadastro não conclui sem prova.
      await registrarDeclaracaoDeMaioridade({
        userId: ctx.user.id,
        termo: termoAceito,
        ipAddress: getRequestIp(ctx.req.headers["x-forwarded-for"], ctx.req.socket?.remoteAddress ?? ctx.req.ip),
        userAgent: ctx.req.headers["user-agent"],
      });
      await upsertUserProfile(ctx.user.id, {
        ...profileData,
        ...(bioPreservada !== null ? { bio: bioPreservada } : {}),
        // Desmarcar "Outra necessidade" apaga o texto: ele não pode seguir
        // valendo como necessidade declarada. Sem seekingTypes no pedido, não mexe.
        ...(input.seekingTypes !== undefined
          ? { seekingOtherNeed: textoDaOutraNecessidade(input.seekingTypes, seekingOtherNeed) }
          : {}),
      });
      const db = await exigirDb();
      await db.update(users).set({
        onboardingCompleted: true,
        company: company,
        position: position,
        country: input.country,
      }).where(eq(users.id, ctx.user.id));
      // Salvar campos v2 no user_profiles
      const profileUpdates: Record<string, unknown> = {};
      // Cargo e empresa vão só para jobTitle/company, a coluna que fica; as
      // antigas (currentRole/currentCompany) não recebem mais escrita.
      const { jobTitle: cargo, company: empresa } = cargoEEmpresaParaGravar({ jobTitle, currentRole, company, currentCompany });
      if (cargo !== undefined) profileUpdates.jobTitle = cargo;
      if (empresa !== undefined) profileUpdates.company = empresa;
      if (activityArea !== undefined) profileUpdates.activityArea = activityArea;
      if (currentResources !== undefined) profileUpdates.currentResources = currentResources;
      if (personType !== undefined) profileUpdates.personType = personType;
      if (personType === "individual") {
        profileUpdates.companySize = null;
        profileUpdates.companyCnpj = null;
      } else {
        if (companySize !== undefined) profileUpdates.companySize = companySize;
        if (companyCnpj !== undefined) profileUpdates.companyCnpj = companyCnpj ? normalizarCadastroEmpresarial(companyCnpj) || null : null;
      }
      if (institutionalNetwork !== undefined) profileUpdates.institutionalNetwork = institutionalNetwork;
      // Colunas json — o Drizzle serializa; passar já stringificado gravaria JSON duplo
      if (interestSectors !== undefined) profileUpdates.interestSectors = interestSectors;
      if (whatIHave !== undefined) profileUpdates.whatIHave = whatIHave;
      if (oQuePreciso.whatINeed !== undefined) profileUpdates.whatINeed = oQuePreciso.whatINeed;
      if (oQuePreciso.whatINeedDetails !== undefined) profileUpdates.whatINeedDetails = oQuePreciso.whatINeedDetails;
      if (Object.keys(profileUpdates).length > 0) {
        await db.update(userProfiles).set(profileUpdates as any).where(eq(userProfiles.userId, ctx.user.id));
      }
      // Governança: o cadastro nasce Bronze; se o que acabou de ser gravado já
      // atende à régua de qualidade, sai daqui Prata. Depois das DUAS escritas
      // acima, porque O que tenho / O que preciso vão na segunda.
      const { promovidaAPrata } = await reavaliarNivelPeloPerfil(ctx.user);
      // Gerar matches automaticamente após onboarding
      try {
        const { generateMatchesForUser } = await import("../matching");
        await generateMatchesForUser(ctx.user.id);
      } catch (e) { console.warn("[Onboarding] Match generation failed:", e); }
      return { success: true, promovidaAPrata };
    }),
});
