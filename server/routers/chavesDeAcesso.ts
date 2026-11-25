import crypto from "node:crypto";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { APELIDO_DA_CHAVE_MAX, ERRO_DA_CHAVE_DE_ACESSO } from "@shared/chaves-de-acesso";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { criarTeto } from "../assistente-de-texto";
import {
  cadastrarChave,
  configuracaoParaOPedido,
  entrarComChave,
  exigirConfiguracao,
  gerarOpcoesDeCadastro,
  gerarOpcoesDeEntrada,
  listarChaves,
  removerChave,
  renomearChave,
} from "../chaves-de-acesso";
import { chaveDeRede, ipDaCliente } from "../ip-da-cliente";
import { gravarCookieDaSessao, sessionTokenDoPedido } from "../sessao";
import { JANELA_DOS_TETOS_DE_AUTH_MS, LOGINS_POR_REDE, LOGINS_POR_REDE_E_EMAIL } from "./auth";

// ============================================================
// CHAVES DE ACESSO (passkeys): entrar com Face ID ou digital
// ============================================================
// O que cada procedimento faz e as regras estão em server/chaves-de-acesso.ts.
// Aqui ficam a porta da função (sem a configuração, ou fora das origens da
// lista, tudo recusa com CHAVE_INDISPONIVEL e o `estado` diz que ela não existe),
// os tetos em memória e o formato das respostas do aparelho.
//
// Os tetos são os do login por senha (routers/auth.ts), contados à parte, por
// chamada, e reservados ANTES do primeiro await, pelo mesmo motivo de lá: um
// lote do tRPC carrega quantas chamadas quiser. A recusa é o código
// CHAVE_MUITAS_TENTATIVAS, que a tela traduz.
const MUITAS = ERRO_DA_CHAVE_DE_ACESSO.muitasTentativas;
/** Opções de entrada por rede: cada pedido grava um desafio. */
export const tetoDeOpcoesDeEntrada = criarTeto(LOGINS_POR_REDE, JANELA_DOS_TETOS_DE_AUTH_MS, MUITAS);
/** Entradas com chave por rede. */
export const tetoDeEntradaComChave = criarTeto(LOGINS_POR_REDE, JANELA_DOS_TETOS_DE_AUTH_MS, MUITAS);
/** Entradas com a MESMA chave por rede, como o teto por rede + e-mail do login por senha. */
export const tetoDeEntradaPorChave = criarTeto(LOGINS_POR_REDE_E_EMAIL, JANELA_DOS_TETOS_DE_AUTH_MS, MUITAS);
/** Opções de cadastro e cadastros por conta: cada pedido de opções grava um desafio. */
export const CADASTROS_DE_CHAVE_POR_CONTA = 30;
export const tetoDeCadastroDeChave = criarTeto(CADASTROS_DE_CHAVE_POR_CONTA, JANELA_DOS_TETOS_DE_AUTH_MS, MUITAS);

/** A chave do teto por credencial: o hash do id, para a memória não guardar ids longos. */
const chaveDaCredencial = (rede: string, credencialId: string) =>
  `${rede}|${crypto.createHash("sha256").update(credencialId).digest("base64url").slice(0, 22)}`;

const navegador = (headers: { "user-agent"?: string }) => headers["user-agent"];

// A porta: a configuração vale para a origem deste pedido, ou CHAVE_INDISPONIVEL
// antes de qualquer outra coisa (inclusive de ler a entrada). Nos logados, ela
// vem depois da sessão e do cadastro concluído (protectedProcedure).
const publicoComChaves = publicProcedure.use(({ ctx, next }) =>
  next({ ctx: { chaves: exigirConfiguracao(ctx.req) } }),
);
const logadaComChaves = protectedProcedure.use(({ ctx, next }) =>
  next({ ctx: { chaves: exigirConfiguracao(ctx.req) } }),
);

// O formato das respostas do aparelho (o toJSON da @simplewebauthn/browser), com
// teto de tamanho em cada campo. Quem confere o conteúdo é a biblioteca.
const base64url = (maximo: number) => z.string().min(1).max(maximo);
const extensoes = z.record(z.string(), z.unknown()).optional();
const anexo = z.enum(["platform", "cross-platform"]).optional();

const respostaDeCadastro = z.object({
  id: base64url(1400),
  rawId: base64url(1400),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: base64url(8192),
    attestationObject: base64url(65536),
    authenticatorData: base64url(65536).optional(),
    transports: z.array(z.string().max(32)).max(16).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url(8192).optional(),
  }),
  authenticatorAttachment: anexo,
  clientExtensionResults: extensoes,
});

const respostaDeEntrada = z.object({
  id: base64url(1400),
  rawId: base64url(1400),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: base64url(8192),
    authenticatorData: base64url(8192),
    signature: base64url(8192),
    userHandle: z.string().max(256).nullish(),
  }),
  authenticatorAttachment: anexo,
  clientExtensionResults: extensoes,
});

const idDaChave = z.string().min(1).max(36);

export const chavesDeAcessoRouter = router({
  // Público e sem banco: a tela pergunta antes de mostrar o botão. O RP ID não
  // é segredo (as opções de entrada e de cadastro já o mandam): a tela o usa
  // para avisar o aparelho da chave que não vale mais (a Signal API do WebAuthn).
  estado: publicProcedure.query(({ ctx }) => {
    const configuracao = configuracaoParaOPedido(ctx.req);
    return configuracao ? { disponivel: true as const, rpId: configuracao.rpId } : { disponivel: false as const };
  }),

  // Mutação, e não consulta: grava o desafio (e o POST leva o cabeçalho Origin).
  // Só com a sessão recente; senão CHAVE_REAUTENTICAR (server/chaves-de-acesso.ts).
  opcoesDeCadastro: logadaComChaves.mutation(async ({ ctx }) => {
    tetoDeCadastroDeChave.reservar(`conta:${ctx.user.id}`);
    return gerarOpcoesDeCadastro(ctx.chaves, ctx.user, { sessionToken: await sessionTokenDoPedido(ctx.req) });
  }),

  cadastrar: logadaComChaves
    .input(z.object({ resposta: respostaDeCadastro, apelido: z.string().max(APELIDO_DA_CHAVE_MAX * 4).nullish() }))
    .mutation(async ({ ctx, input }) => {
      tetoDeCadastroDeChave.reservar(`conta:${ctx.user.id}`);
      const resposta = { ...input.resposta, clientExtensionResults: input.resposta.clientExtensionResults ?? {} } as RegistrationResponseJSON;
      return cadastrarChave(ctx.chaves, ctx.user, { resposta, apelido: input.apelido }, {
        ip: ipDaCliente(ctx.req),
        userAgent: navegador(ctx.req.headers),
        sessionToken: await sessionTokenDoPedido(ctx.req),
      });
    }),

  opcoesDeEntrada: publicoComChaves.mutation(({ ctx }) => {
    tetoDeOpcoesDeEntrada.reservar(chaveDeRede(ipDaCliente(ctx.req)));
    return gerarOpcoesDeEntrada(ctx.chaves);
  }),

  // A sessão nasce aqui, como no auth.login: o cookie só sai com a entrada inteira confirmada.
  entrar: publicoComChaves
    .input(z.object({ resposta: respostaDeEntrada }))
    .mutation(async ({ ctx, input }) => {
      const ip = ipDaCliente(ctx.req);
      const rede = chaveDeRede(ip);
      tetoDeEntradaComChave.reservar(rede);
      tetoDeEntradaPorChave.reservar(chaveDaCredencial(rede, input.resposta.id));
      const resposta = {
        ...input.resposta,
        response: { ...input.resposta.response, userHandle: input.resposta.response.userHandle ?? undefined },
        clientExtensionResults: input.resposta.clientExtensionResults ?? {},
      } as AuthenticationResponseJSON;
      const { token, usuaria } = await entrarComChave(ctx.chaves, resposta, { ip, rede, userAgent: navegador(ctx.req.headers) });
      gravarCookieDaSessao(ctx.req, ctx.res, token);
      return { success: true, user: usuaria } as const;
    }),

  listar: logadaComChaves.query(({ ctx }) => listarChaves(ctx.user.id)),

  renomear: logadaComChaves
    .input(z.object({ id: idDaChave, apelido: z.string().max(APELIDO_DA_CHAVE_MAX * 4).nullable() }))
    .mutation(async ({ ctx, input }) => {
      await renomearChave(ctx.user.id, input.id, input.apelido);
      return { success: true } as const;
    }),

  remover: logadaComChaves
    .input(z.object({ id: idDaChave }))
    .mutation(async ({ ctx, input }) => {
      await removerChave(ctx.user.id, input.id, { ip: ipDaCliente(ctx.req), userAgent: navegador(ctx.req.headers) });
      return { success: true } as const;
    }),
});
