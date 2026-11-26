import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { adminProcedure, entidadeProcedure } from "./_procedures";
import {
  atualizarEntidade, concluirImportacao, contatoDoMembro, conviteAtual, criarEntidade, entidadeDaConta, gerarConvite,
  iniciarImportacao, lerConvite, listarEntidadesParaAEquipe, listarMembros, processarBlocoComNovaTentativa,
  refazerOfertasDaCnae, resumoDaEntidade, revogarConvite, ultimasImportacoes,
} from "../entidades";
import { decidirPedido, listarPedidosDaEntidade } from "../pedidos-pela-entidade";
import { ACOES_DA_ENTIDADE, CANAIS_DO_PEDIDO } from "../../shared/pedidos-pela-entidade";
import {
  CAMPOS_DA_PLANILHA, ESTADOS_DO_CONVENIO, ITENS_POR_LADO_MAX, LINKS_DE_ATIVACAO_POR_CHAMADA, LINHAS_POR_ARQUIVO_MAX, LINHAS_POR_BLOCO, PAISES_DE_ENTIDADE, TIPOS_DE_ENTIDADE,
  type CampoDaPlanilha,
} from "../../shared/entidades";
import { ativarCadastro, gerarLinksDeAtivacao, lerAtivacao } from "../entidades-ativacao";
import { criarTeto } from "../assistente-de-texto";
import { chaveDeRede, ipDaCliente } from "../ip-da-cliente";
import { tetoDeCadastro } from "./auth";
import { abrirSessao, gravarCookieDaSessao } from "../sessao";
import { createAuditLog } from "../security";

/**
 * A base das associações (N1). Três portas:
 * - `entidades.*` (entidadeProcedure): a conta da entidade, sobre os PRÓPRIOS associados;
 * - `entidades.admin.*` (adminProcedure: admin, presidência e Ouro): cria a
 *   entidade e cuida do convênio; vê contagens, nunca coluna pessoal de associado;
 * - `conviteDeEntidade.ver` (público): o nome da entidade a quem abriu o link;
 * - `ativacaoDeCadastro.*` (público, N3): o link de uso único de um associado.
 */

// Cada campo da linha é texto curto; o "o que tem" e o "o que precisa" podem ser longos.
const linha = z.object(Object.fromEntries(CAMPOS_DA_PLANILHA.map(campo => [
  campo, z.string().max(campo === "o_que_tem" || campo === "o_que_precisa" ? 8000 : 400).optional(),
])) as Record<CampoDaPlanilha, z.ZodOptional<z.ZodString>>).strict();

const dadosDaEntidade = z.object({
  nome: z.string().trim().min(2).max(200),
  tipo: z.enum(TIPOS_DE_ENTIDADE),
  convenioEstado: z.enum(ESTADOS_DO_CONVENIO),
  convenioInicio: z.number().int().nullable(),
  convenioFim: z.number().int().nullable(),
  convenioReferencia: z.string().trim().max(120).nullable(),
  mostrarNomeNoMatch: z.boolean(),
  disponivelPorPadrao: z.boolean(),
});

export const entidadesRouter = router({
  minha: entidadeProcedure.query(async ({ ctx }) => resumoDaEntidade(await entidadeDaConta(ctx.user.openId))),

  membros: entidadeProcedure
    .input(z.object({ busca: z.string().max(100).optional(), pagina: z.number().int().min(0).max(10_000).optional() }))
    .query(async ({ ctx, input }) => listarMembros(await entidadeDaConta(ctx.user.openId), ctx.user.id, input)),

  contatoDoMembro: entidadeProcedure
    .input(z.object({ membroId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => contatoDoMembro(await entidadeDaConta(ctx.user.openId), ctx.user.id, input.membroId)),

  importacoes: entidadeProcedure.query(async ({ ctx }) => ultimasImportacoes(await entidadeDaConta(ctx.user.openId))),

  iniciarImportacao: entidadeProcedure
    .input(z.object({
      modo: z.enum(["ensaio", "aplicar"]),
      arquivoSha256: z.string().regex(/^[0-9a-f]{64}$/),
      totalLinhas: z.number().int().min(1).max(LINHAS_POR_ARQUIVO_MAX),
    }))
    .mutation(async ({ ctx, input }) => iniciarImportacao(await entidadeDaConta(ctx.user.openId), ctx.user.id, input)),

  importarBloco: entidadeProcedure
    .input(z.object({
      importacaoId: z.number().int().positive(),
      inicio: z.number().int().min(0).max(LINHAS_POR_ARQUIVO_MAX),
      linhas: z.array(linha).min(1).max(LINHAS_POR_BLOCO),
    }))
    .mutation(async ({ ctx, input }) => processarBlocoComNovaTentativa(await entidadeDaConta(ctx.user.openId), input)),

  concluirImportacao: entidadeProcedure
    .input(z.object({ importacaoId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => concluirImportacao(await entidadeDaConta(ctx.user.openId), ctx.user.id, input.importacaoId)),

  convite: entidadeProcedure.query(async ({ ctx }) => conviteAtual(await entidadeDaConta(ctx.user.openId))),

  gerarConvite: entidadeProcedure.mutation(async ({ ctx }) => gerarConvite(await entidadeDaConta(ctx.user.openId), ctx.user.id)),

  revogarConvite: entidadeProcedure.mutation(async ({ ctx }) => {
    await revogarConvite(await entidadeDaConta(ctx.user.openId), ctx.user.id);
    return { ok: true };
  }),

  // N2: os pedidos de contato que chegaram à entidade, e o que ela registra de cada um.
  pedidos: entidadeProcedure
    .input(z.object({ abertos: z.boolean().optional(), pagina: z.number().int().min(0).max(10_000).optional() }))
    .query(async ({ ctx, input }) => listarPedidosDaEntidade(await entidadeDaConta(ctx.user.openId), ctx.user.id, input)),

  decidirPedido: entidadeProcedure
    .input(z.object({ pedidoId: z.string().uuid(), acao: z.enum(ACOES_DA_ENTIDADE), canal: z.enum(CANAIS_DO_PEDIDO).optional() }))
    .mutation(async ({ ctx, input }) => decidirPedido(await entidadeDaConta(ctx.user.openId), ctx.user.id, input)),

  // A ativação do cadastro importado (N3): o link de uso único por associado. O token sai só nesta resposta.
  gerarLinksDeAtivacao: entidadeProcedure
    .input(z.union([
      z.object({ membroIds: z.array(z.number().int().positive()).min(1).max(LINKS_DE_ATIVACAO_POR_CHAMADA) }),
      z.object({ pendentesDepoisDoId: z.number().int().min(0) }),
    ]))
    .mutation(async ({ ctx, input }) => gerarLinksDeAtivacao(await entidadeDaConta(ctx.user.openId), ctx.user.id, input)),

  admin: router({
    listar: adminProcedure.query(() => listarEntidadesParaAEquipe()),
    criar: adminProcedure
      .input(dadosDaEntidade.extend({ emailDaConta: z.string().trim().email().max(320), pais: z.enum(PAISES_DE_ENTIDADE as [string, ...string[]]) }))
      .mutation(({ ctx, input }) => criarEntidade(ctx.user.id, input)),
    atualizar: adminProcedure
      .input(dadosDaEntidade.extend({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { id, ...dados } = input;
        await atualizarEntidade(ctx.user.id, id, dados);
        return { ok: true };
      }),
    // R-49: depois de a tabela da CNAE mudar (server/cnae.ts), refaz as ofertas "cnae" dos importados. Só contagens voltam.
    refazerOfertasDaCnae: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ ctx, input }) => refazerOfertasDaCnae(ctx.user.id, input.id)),
  }),
});

export const conviteDeEntidadeRouter = router({
  // Público: quem recebeu o link ainda não tem conta. O token é aleatório (24 bytes) e só vale com o convênio vigente.
  ver: publicProcedure
    .input(z.object({ token: z.string().max(100) }))
    .query(({ input }) => lerConvite(input.token)),
});

/**
 * Ver a página da ativação, por rede: o token tem 24 bytes aleatórios, e o teto
 * só tira a graça de varrer. Fica bem acima do uso honesto de um escritório
 * inteiro abrindo os links no mesmo wi-fi.
 */
export const VISTAS_DA_ATIVACAO_POR_REDE = 300;
export const tetoDaVistaDaAtivacao = criarTeto(
  VISTAS_DA_ATIVACAO_POR_REDE, 15 * 60_000,
  "Muitas tentativas a partir desta rede. Aguarde alguns minutos e tente de novo.",
);

const itens = z.array(z.string().max(500)).max(ITENS_POR_LADO_MAX);

export const ativacaoDeCadastroRouter = router({
  // Público: quem recebeu o link ainda não tem conta. Só o nome da entidade, o da empresa e os itens importados.
  ver: publicProcedure
    .input(z.object({ token: z.string().max(100) }))
    .query(({ ctx, input }) => {
      tetoDaVistaDaAtivacao.reservar(chaveDeRede(ipDaCliente(ctx.req)));
      return lerAtivacao(input.token);
    }),

  // Cria a conta e já abre a sessão: a tela segue para o cadastro (Termo Geral e maioridade), preenchido.
  ativar: publicProcedure
    .input(z.object({
      token: z.string().max(100),
      nome: z.string().trim().min(2).max(100),
      email: z.string().trim().email().max(320),
      senha: z.string().min(8).max(200),
      empresa: z.string().trim().max(200),
      tenho: itens,
      preciso: itens,
    }))
    .mutation(async ({ ctx, input }) => {
      // O mesmo teto do cadastro comum, antes de qualquer await.
      tetoDeCadastro.reservar(chaveDeRede(ipDaCliente(ctx.req)));
      const { token, ...dados } = input;
      const conta = await ativarCadastro(token, dados);
      const ip = ipDaCliente(ctx.req);
      const userAgent = ctx.req.headers["user-agent"];
      const sessao = await abrirSessao({ usuaria: { id: conta.userId, openId: conta.openId, name: conta.name, email: conta.email }, ip, userAgent });
      gravarCookieDaSessao(ctx.req, ctx.res, sessao.token);
      await createAuditLog({ userId: conta.userId, action: "LOGIN", resource: "auth", ipAddress: ip, userAgent, status: "success", riskLevel: "low" });
      return { ok: true as const };
    }),
});
