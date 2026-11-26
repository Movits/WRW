import { TRPCError } from "@trpc/server";
import crypto from "node:crypto";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { transcricaoCabeNaDuracao } from "../assistente-de-texto";
import { exigirDb } from "../db";
import { GeminiIndisponivelError, transcribeWithGemini } from "../gemini";
import { recalculatePrivateMatches } from "../match-service";
import { ALLOWED_MEETING_AUDIO_TYPES, decodeMeetingAudio } from "../meeting-service";
import { registrarConsumoDeMinutos, resumoDeMinutos } from "../minutos-de-reuniao";
import {
  gravarPendencias, identificacaoDoContato, interpretarComplemento, listarPendencias,
  PendenciaNaoEncontrada, pendenciasDaProposta, retratoDoContato, semRepeticao, ValorInvalido, type Identificacao,
} from "../network-extracao";
import { reavaliarNivelPeloPerfil } from "../nivel-do-perfil";
import { confirmarItemDaDona, ignorarItemDaDona, pendenciasDoPerfil, recalcularOMotorDePerfis } from "../reuniao-no-match";
import { CHAVES_O_QUE_PRECISO, type ChaveOQuePreciso } from "@shared/o-que-preciso";
import { ALVOS_DO_ITEM } from "@shared/reuniao-no-match";
import { resumoDoNetworkInteligente } from "../network-inteligente";
import { garantirCodigosAnonimos } from "../network-codigo-anonimo";
import { perfilDoContato } from "../network-perfil-do-contato";
import { AssociadoAtivado, ContatoNaoEncontrado, definirDisponibilidade, procurarConexoesNaRedeGlobal } from "../network-rede-global";
import {
  avancarConexao, ComissaoAntesDoFechamento, ConexaoNaoEncontrada, contarConexoes, definirStatusDeComissao,
  ETAPAS_DA_CONEXAO, EtapaForaDeOrdem, listarConexoesDaSolicitante, listarTodasAsConexoes, ORIGENS_DA_CONEXAO, sincronizarConexoesInternas,
  trancarANotaEntreMembras, type ConexaoParaQuemPergunta,
} from "../network-registro";
import { createAuditLog } from "../security";
import { anotarConexoesComEntidade, contatoPeloPedido, pedirContatoPelaEntidade } from "../pedidos-pela-entidade";
import { MENSAGEM_DO_PEDIDO_MAX } from "@shared/pedidos-pela-entidade";
import { veAsConexoesSugeridas } from "@shared/qualificacao-do-perfil";
import { hasValidConsent } from "./consent";
import { plataformaProcedure } from "./_procedures";

/**
 * Meu Network Inteligente — a rede particular da dona como inteligência
 * (pedido do Nicolas, 13/09/2026, e spec da Glenda de 14/09, prompt 7).
 *
 * Tudo aqui é da própria dona: o openId dela vai em toda consulta, e contato
 * de outra dona sai como NOT_FOUND sem revelar se existe.
 *
 * O termo do Smart Match decide o CRUZAMENTO, como na tela de Conexões
 * Inteligentes: sem ele o resumo não conta sugestões, a lista de conexões
 * registradas não aparece e a busca na rede global recusa. O resto (reuniões,
 * contatos, Quem Sou / Tenho / Preciso, pendências, minutos) é dado da agenda
 * e não depende do termo.
 */

// A interpretação por texto e por voz custa IA (e a voz, transcrição): teto
// brando por dona, em memória, no molde do reprocessamento de reuniões.
const COMPLEMENTOS_POR_JANELA = 10;
const JANELA_DE_COMPLEMENTO_MS = 10 * 60_000;
const complementosPorDona = new Map<string, number[]>();

/** Só para os testes: o teto é estado de módulo. */
export function esquecerComplementos() {
  complementosPorDona.clear();
}

function reservarComplemento(openId: string) {
  const agora = Date.now();
  const recentes = (complementosPorDona.get(openId) ?? []).filter(momento => agora - momento < JANELA_DE_COMPLEMENTO_MS);
  if (recentes.length >= COMPLEMENTOS_POR_JANELA) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitas interpretações em sequência. Aguarde alguns minutos e tente de novo." });
  }
  if (complementosPorDona.size > 5000) complementosPorDona.clear();
  recentes.push(agora);
  complementosPorDona.set(openId, recentes);
}

/** O áudio curto de complemento por voz: 2 minutos bastam para ditar o que falta. */
export const LIMITE_DA_VOZ_SEGUNDOS = 120;
const LIMITE_DA_VOZ_BYTES = 2 * 1024 * 1024;

const termoDoSmartMatch = (userId: number) => hasValidConsent(userId, "termo_smart_match");

/** As 17 categorias de "O que preciso", na forma que o z.enum pede (a lista é a de shared/o-que-preciso.ts). */
const CHAVES_DO_PRECISO = CHAVES_O_QUE_PRECISO as unknown as [ChaveOQuePreciso, ...ChaveOQuePreciso[]];

// A rastreabilidade das conexões é da PLATAFORMA (admin e presidente):
// plataformaProcedure, em routers/_procedures.ts.

export const MENSAGEM_INTERPRETACAO_FALHOU = "Não foi possível interpretar as informações agora. Tente de novo em alguns minutos.";

/**
 * A interpretação pela IA, com a falha dita em frase neutra. O erro cru do
 * provedor ("LLM invoke failed: 429 … {corpo do Google}", ou a chave que falta
 * no .env) fica no log, truncado; o errorFormatter só mascara erro de banco,
 * então sem isto ele chegaria ao navegador. A interpretação não toca o banco:
 * um ECONNREFUSED aqui é do fetch ao provedor, e `ehErroDeBancoIndisponivel`
 * o confundiria com queda do banco — por isso não há relançamento para ela.
 */
async function interpretarOuFalharComFraseNeutra(fonte: string, nomeDoContato: string, identificacao: Identificacao) {
  try {
    return await interpretarComplemento(fonte, { nomeDoContato, identificacao });
  } catch (erro) {
    if (erro instanceof TRPCError) throw erro;
    console.warn("[Network Inteligente] a interpretação falhou:", erro instanceof Error ? erro.message.slice(0, 300) : erro);
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_INTERPRETACAO_FALHOU });
  }
}

/**
 * Depois de um "tenho" ou "preciso" novo: o motor privado recalcula e o
 * registro recebe as conexões internas novas (item 16) — o próprio
 * `recalculatePrivateMatches` registra no fim, então não há segunda chamada
 * aqui. Melhor esforço, como em routers/network.ts: o dado confirmado já está
 * gravado, e uma falha no recálculo não pode virar erro da confirmação — o
 * próximo recálculo, ou a próxima abertura do painel, alcança.
 */
async function recalcularERegistrar(user: { id: number; openId: string; email?: string | null }) {
  try {
    if (!(await termoDoSmartMatch(user.id))) return;
    await recalculatePrivateMatches(user.openId, user.email);
  } catch (erro) {
    console.warn("[Network Inteligente] recálculo adiado:", erro instanceof Error ? erro.message : erro);
  }
}

function traduzirErro(erro: unknown): never {
  if (erro instanceof ContatoNaoEncontrado || erro instanceof ConexaoNaoEncontrada || erro instanceof PendenciaNaoEncontrada) {
    throw new TRPCError({ code: "NOT_FOUND", message: erro.message });
  }
  if (erro instanceof EtapaForaDeOrdem || erro instanceof ComissaoAntesDoFechamento || erro instanceof AssociadoAtivado) {
    throw new TRPCError({ code: "CONFLICT", message: erro.message });
  }
  if (erro instanceof ValorInvalido) throw new TRPCError({ code: "BAD_REQUEST", message: erro.message });
  throw erro;
}

async function exigirContatoDaDona(ownerId: string, contactId: number) {
  const db = await exigirDb();
  const retrato = await retratoDoContato(db, ownerId, contactId);
  if (!retrato) throw new TRPCError({ code: "NOT_FOUND", message: "Contato não encontrado na sua rede." });
  return { db, retrato };
}

const etapaDestino = z.enum(["apresentacao", "negociacao", "fechada", "descartada"]);

export const networkInteligenteRouter = router({
  resumo: protectedProcedure.query(async ({ ctx }) => {
    const termoSmartMatch = await termoDoSmartMatch(ctx.user.id);
    // Item 13: todo contato tem ID anônimo. Os criados antes da coluna ganham
    // o dele na primeira abertura do painel (só os desta dona, sem trocar
    // código já dado).
    await garantirCodigosAnonimos(ctx.user.openId);
    return resumoDoNetworkInteligente(ctx.user.openId, { termoSmartMatch });
  }),

  // Itens 4, 19 e 25: consumo do mês, limite por reunião, limite mensal (se um
  // plano o definir) e se a ampliação está disponível — hoje não está, e o
  // motivo vai junto: depende da integração de pagamento.
  minutos: protectedProcedure.query(({ ctx }) => resumoDeMinutos(ctx.user)),

  // Itens 16, 17 e 19: as conexões registradas em que a dona participa, com as
  // contagens do painel. Com o termo, as sugestões internas que ainda não
  // estavam no registro entram antes da leitura.
  conexoes: protectedProcedure.query(async ({ ctx }) => {
    if (!(await termoDoSmartMatch(ctx.user.id))) return { termoAceito: false as const };
    await sincronizarConexoesInternas(ctx.user.openId);
    const lista = await listarConexoesDaSolicitante(ctx.user);
    // U3: a nota das conexões entre membras (PLATFORM_MATCH) não vai a quem ainda não vê a lista das conexões
    // sugeridas (a Bronze, inclusive a que tem o poder de distribuidora: o poder não é nível). A contagem não lê nota.
    const visiveis: ConexaoParaQuemPergunta[] = veAsConexoesSugeridas(ctx.user.role) ? lista : trancarANotaEntreMembras(lista);
    // N2: o lado que é associado de uma entidade sai como "membro da entidade X", com o pedido de contato.
    const anotadas = await anotarConexoesComEntidade(ctx.user, visiveis.slice(0, 50));
    return { termoAceito: true as const, contagem: contarConexoes(lista), lista: anotadas };
  }),

  avancarConexao: protectedProcedure
    .input(z.object({ conexaoId: z.string().uuid(), etapa: etapaDestino }))
    .mutation(async ({ ctx, input }) => {
      try {
        const resultado = await avancarConexao(ctx.user, input.conexaoId, input.etapa);
        await createAuditLog({
          userId: ctx.user.id, action: "NETWORK_CONNECTION_STAGE", resource: "conexoes_registradas", resourceId: input.conexaoId,
          details: { etapa: input.etapa }, status: "success", riskLevel: "low",
        });
        return resultado;
      } catch (erro) {
        traduzirErro(erro);
      }
    }),

  // Itens 15B e 17: cruza os contatos que a dona disponibilizou com a rede
  // global (outros networks autorizados e membras) e registra o que achar.
  procurarNaRedeGlobal: protectedProcedure
    .input(z.object({ contactId: z.number().int().positive().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      if (!(await termoDoSmartMatch(ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "SMART_MATCH_CONSENT_REQUIRED" });
      }
      return procurarConexoesNaRedeGlobal(ctx.user, { contactId: input?.contactId });
    }),

  // N2: pedir o contato do associado do outro lado de uma conexão pela entidade
  // dele. O nome de quem pede vai à entidade (a tela avisa e pede a ciência).
  pedirContatoPelaEntidade: protectedProcedure
    .input(z.object({
      conexaoId: z.string().uuid(),
      mensagem: z.string().max(MENSAGEM_DO_PEDIDO_MAX).optional(),
      cienteDoNome: z.literal(true),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!(await termoDoSmartMatch(ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "SMART_MATCH_CONSENT_REQUIRED" });
      }
      return pedirContatoPelaEntidade(ctx.user, { conexaoId: input.conexaoId, mensagem: input.mensagem });
    }),

  // N2: no "aceito", o nome da empresa e o canal que ela escolheu, com auditoria.
  contatoPeloPedido: protectedProcedure
    .input(z.object({ pedidoId: z.string().uuid() }))
    .mutation(({ ctx, input }) => contatoPeloPedido(ctx.user, input.pedidoId)),

  // Itens 20 e 22: o perfil do contato e a memória de relacionamento.
  contato: protectedProcedure
    .input(z.object({ contactId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const termoSmartMatch = await termoDoSmartMatch(ctx.user.id);
      const perfil = await perfilDoContato(ctx.user, input.contactId, { termoSmartMatch });
      if (!perfil) throw new TRPCError({ code: "NOT_FOUND", message: "Contato não encontrado na sua rede." });
      if (!perfil.conexoes.termoAceito) return perfil;
      return { ...perfil, conexoes: { ...perfil.conexoes, lista: await anotarConexoesComEntidade(ctx.user, perfil.conexoes.lista) } };
    }),

  // Itens 14 e 26: "Disponibilizar este contato para oportunidades da rede",
  // SIM/NÃO. Retirar a autorização vale na leitura seguinte da rede global.
  definirDisponibilidade: protectedProcedure
    .input(z.object({ contactId: z.number().int().positive(), disponivel: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const resultado = await definirDisponibilidade(ctx.user.openId, input.contactId, input.disponivel);
        await createAuditLog({
          userId: ctx.user.id, action: input.disponivel ? "NETWORK_CONTACT_AVAILABLE" : "NETWORK_CONTACT_WITHDRAWN",
          resource: "private_contacts", resourceId: String(input.contactId), status: "success", riskLevel: "medium",
        });
        return resultado;
      } catch (erro) {
        traduzirErro(erro);
      }
    }),

  // Itens 9 e 10: o que a IA propôs e ainda espera a confirmação da dona.
  // `alvo` (N5) separa as do contato das que vão ao perfil dela.
  pendencias: protectedProcedure
    .input(z.object({
      contactId: z.number().int().positive().optional(),
      meetingId: z.string().uuid().optional(),
      alvo: z.enum(ALVOS_DO_ITEM).optional(),
    }))
    .query(({ ctx, input }) => listarPendencias(ctx.user.openId, input)),

  // N5: o que as reuniões propõem para o PERFIL da dona ("Sou eu"), com a
  // reunião de onde veio — o bloco "Sugestões das suas reuniões" do Perfil.
  pendenciasDoPerfil: protectedProcedure.query(({ ctx }) => pendenciasDoPerfil(ctx.user.openId)),

  // Confirmar vale para os dois destinos (N5): o item do contato vai a
  // contact_assets/contact_needs e o motor privado recalcula, como sempre; o do
  // perfil vai a "O que tenho"/"O que preciso", a régua da Prata é refeita, e o
  // motor de perfis recalcula uma vez por reunião, em segundo plano, quando
  // ela termina de decidir o que vai ao perfil.
  confirmarPendencia: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      valor: z.string().trim().min(1).max(320).optional(),
      categoria: z.enum(CHAVES_DO_PRECISO).optional(),
      servico: z.string().trim().max(40).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const resultado = await confirmarItemDaDona(ctx.user, input.id, { valor: input.valor, categoria: input.categoria, servico: input.servico });
        if (resultado.alvo === "contato") {
          if (resultado.mudouTenhoOuPreciso) await recalcularERegistrar(ctx.user);
          return { ...resultado, promovidaAPrata: false };
        }
        const { promovidaAPrata } = resultado.mudouPerfil ? await reavaliarNivelPeloPerfil(ctx.user) : { promovidaAPrata: false };
        if (resultado.reuniaoDecidida) void recalcularOMotorDePerfis(ctx.user.id);
        return { ...resultado, promovidaAPrata };
      } catch (erro) {
        traduzirErro(erro);
      }
    }),

  ignorarPendencia: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const resultado = await ignorarItemDaDona(ctx.user, input.id);
        if (resultado.reuniaoDecidida) void recalcularOMotorDePerfis(ctx.user.id);
        return resultado;
      } catch (erro) {
        traduzirErro(erro);
      }
    }),

  // Item 10, completar por TEXTO: a dona escreve com as palavras dela, a IA
  // interpreta, o portão confere cada item contra o próprio texto, e o que
  // sobra vira pendência para ela confirmar.
  complementarPorTexto: protectedProcedure
    .input(z.object({ contactId: z.number().int().positive(), texto: z.string().trim().min(5).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const { db, retrato } = await exigirContatoDaDona(ctx.user.openId, input.contactId);
      reservarComplemento(ctx.user.openId);
      // A empresa que a reunião deu ao contato e ainda espera a dona também não entra no item (revisão da IA3).
      const identificacao = await identificacaoDoContato(db, ctx.user.openId, retrato);
      const proposta = await interpretarOuFalharComFraseNeutra(input.texto, retrato.fullName, identificacao);
      const linhas = semRepeticao(pendenciasDaProposta(proposta), retrato);
      const criadas = await gravarPendencias(db, { ownerId: ctx.user.openId, origem: "texto", contactId: input.contactId, linhas });
      return { pendenciasCriadas: criadas };
    }),

  // Item 10, completar por VOZ: gravar → transcrever → interpretar → sugerir →
  // confirmar → salvar. O áudio NÃO é guardado: é transcrito na memória e
  // descartado; a transcrição volta só nesta resposta, para a dona ver o que
  // foi entendido. Os segundos entram no contador de minutos só depois de a
  // interpretação dar certo: se a IA falha, a dona não perdeu nada e grava de novo.
  complementarPorVoz: protectedProcedure
    .input(z.object({
      contactId: z.number().int().positive(),
      audioBase64: z.string().min(20).max(3_000_000),
      mimeType: z.enum(ALLOWED_MEETING_AUDIO_TYPES),
      durationSeconds: z.number().positive().max(LIMITE_DA_VOZ_SEGUNDOS),
      // O idioma da tela de quem grava, como no ditado. O transcribeWithGemini o
      // normaliza (nomeDoIdioma); sem ele, ou fora dos 10, o prompt não pede idioma.
      idioma: z.string().max(12).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, retrato } = await exigirContatoDaDona(ctx.user.openId, input.contactId);
      let audio: Buffer;
      try {
        audio = decodeMeetingAudio(input.audioBase64, input.mimeType);
      } catch (erro) {
        throw new TRPCError({ code: "BAD_REQUEST", message: erro instanceof Error ? erro.message : "Áudio inválido." });
      }
      if (audio.length > LIMITE_DA_VOZ_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: "O áudio deve ter no máximo 2 MB." });
      reservarComplemento(ctx.user.openId);

      let transcricao: string;
      try {
        transcricao = (await transcribeWithGemini({ audio, mimeType: input.mimeType, language: input.idioma })).text;
      } catch (erro) {
        if (erro instanceof GeminiIndisponivelError) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: erro.message });
        console.error("[Network Inteligente] a transcrição da voz falhou:", erro instanceof Error ? erro.message : erro);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível transcrever o áudio." });
      }
      // durationSeconds vem do navegador e é o que entra no contador. Fala demais
      // para a duração declarada prova que o áudio era mais longo: nada volta e
      // nada conta (ver transcricaoCabeNaDuracao em assistente-de-texto.ts).
      if (!transcricaoCabeNaDuracao(transcricao, input.durationSeconds)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "O áudio é mais longo do que a duração informada. Grave de novo, com até 2 minutos." });
      }
      const identificacao = await identificacaoDoContato(db, ctx.user.openId, retrato);
      const proposta = await interpretarOuFalharComFraseNeutra(transcricao, retrato.fullName, identificacao);
      await registrarConsumoDeMinutos(db, {
        ownerId: ctx.user.openId, origem: "voz", referencia: crypto.randomUUID(), segundos: input.durationSeconds,
      });
      const linhas = semRepeticao(pendenciasDaProposta(proposta), retrato);
      const criadas = await gravarPendencias(db, { ownerId: ctx.user.openId, origem: "voz", contactId: input.contactId, linhas });
      return { transcricao, pendenciasCriadas: criadas };
    }),

  // Rastreabilidade para a PLATAFORMA (itens 17 e 18): todas as conexões, com a
  // conta responsável por cada lado e nada do contato além do ID anônimo.
  // Comissão é status — sem valor, percentual ou cobrança. Só staff (admin e
  // presidente), e a leitura fica na trilha de auditoria.
  admin: router({
    conexoes: plataformaProcedure
      .input(z.object({ origem: z.enum(ORIGENS_DA_CONEXAO).optional(), status: z.enum(ETAPAS_DA_CONEXAO).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const lista = await listarTodasAsConexoes({ origem: input?.origem, status: input?.status });
        // Leitura que atravessa as redes de todas as donas: "quem viu as
        // conexões do meu network?" precisa ter resposta, como GOLD_ACERVO_READ.
        // Por isso a trilha guarda as CONTAS cujas conexões saíram nesta
        // leitura (id da conta responsável por cada lado, que a lista já traz),
        // e não só quantas linhas foram lidas: com a contagem sozinha, a
        // pergunta não tem resposta. Nada de contato vai junto — nome, telefone
        // e e-mail nunca entram nesta lista, e o teto de 200 conexões da
        // consulta limita o tamanho do registro.
        const contas = lista.flatMap(conexao => conexao.lados.map(lado => lado.conta?.id));
        const donas = Array.from(new Set(contas.filter((id): id is number => typeof id === "number"))).sort((a, b) => a - b);
        // Lado cuja conta não resolve (linha legada, conta apagada) sairia da
        // lista em silêncio, e a leitura pareceria ter coberto todas as donas.
        const ladosSemConta = contas.filter(id => typeof id !== "number").length;
        await createAuditLog({
          userId: ctx.user.id, action: "NETWORK_CONNECTIONS_READ", resource: "conexoes_registradas",
          details: { origem: input?.origem ?? null, status: input?.status ?? null, conexoes: lista.length, donas, ladosSemConta },
          status: "success", riskLevel: "medium",
        });
        return lista;
      }),

    definirComissao: plataformaProcedure
      .input(z.object({
        conexaoId: z.string().uuid(),
        status: z.enum(["a_apurar", "devida", "nao_devida"]),
        participanteId: z.number().int().positive().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          const resultado = await definirStatusDeComissao(input);
          await createAuditLog({
            userId: ctx.user.id, action: "NETWORK_COMMISSION_STATUS", resource: "conexoes_registradas", resourceId: input.conexaoId,
            details: { status: input.status, participanteId: input.participanteId ?? null }, status: "success", riskLevel: "medium",
          });
          return resultado;
        } catch (erro) {
          traduzirErro(erro);
        }
      }),
  }),
});
