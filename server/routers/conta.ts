// A conta da própria dona: hoje só a exclusão.
//
// O cartão "Não existe caminho para excluir os dados de uma usuária" pedia o
// caminho que faltava: até aqui a única forma de sair da plataforma era pedir
// para alguém rodar SQL à mão no Aiven. O que este procedimento faz de
// diferente de um DELETE solto está em `server/exclusao-de-conta.ts`; o que
// está AQUI é a autorização, e ela tem três travas, nesta ordem:
//
// 1. A palavra digitada tem de ser o e-mail da própria conta. Não é segurança
//    (quem está logada sabe o próprio e-mail): é a trava contra o clique sem
//    querer, e é independente de idioma — uma palavra traduzida em 10 JSONs
//    nunca casaria com uma constante do servidor.
// 2. A SENHA é conferida de novo, com bcrypt, como no login. Sessão roubada não
//    apaga a vida de ninguém. Conta sem senha (login por provedor externo) é
//    recusada com instrução, não com erro genérico.
// 3. A última administradora não pode se apagar. Sem nenhuma conta
//    {admin, president, gold} a plataforma fica sem moderação de oportunidade,
//    sem painel e sem quem conceda Ouro — um estado do qual não se sai pela
//    interface.
//
// Tentativa de senha errada é registrada e, passando de LIMITE_DE_TENTATIVAS na
// janela, o procedimento fecha: o limite por minuto da API (por conta, ver
// server/_core/limite-de-requisicoes.ts) não serve de nada aqui, porque este
// endpoint responde "senha certa/errada" para quem já tem a sessão.

import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "../_core/cookies";
import { protectedProcedure, router } from "../_core/trpc";
import { exigirDb } from "../db";
import { createAuditLog } from "../security";
import { getRequestIp } from "../password-reset-security";
import { auditLogs, users } from "../../drizzle/schema";
import { excluirConta } from "../exclusao-de-conta";

export const ACAO_EXCLUSAO = "ACCOUNT_DELETED";
export const ACAO_EXCLUSAO_RECUSADA = "ACCOUNT_DELETE_FAILED";
export const LIMITE_DE_TENTATIVAS = 5;
export const JANELA_DE_TENTATIVAS_MS = 15 * 60 * 1000;

/** Os papéis que enxergam o painel de governança (o mesmo trio de `_procedures.ts`). */
export const PAPEIS_DE_GOVERNANCA = ["admin", "president", "gold"] as const;

/**
 * O que a dona tem de digitar para confirmar. O e-mail da própria conta quando
 * existe; a palavra fixa quando a conta veio de provedor externo sem e-mail.
 * Pura, para o teste e o client concordarem sem copiar a regra.
 */
export const PALAVRA_DE_CONFIRMACAO = "EXCLUIR";

/**
 * Quantas entradas de arquivo cabem no registro de auditoria. Existe teto porque
 * `audit_logs.details` é uma coluna JSON numa linha só: uma conta com milhares
 * de mídias e um bucket fora do ar geraria um registro que o driver não grava —
 * e auditoria que falha em gravar é auditoria que não existe (`createAuditLog`
 * engole o erro de propósito, para a falha dela nunca derrubar a exclusão). O
 * teto é generoso para o caso real (um punhado de objetos) e a contagem
 * completa continua em `arquivosComFalha`.
 */
export const TETO_DE_CHAVES_NA_AUDITORIA = 200;

/**
 * A PASTA da chave: tudo menos o nome do arquivo. É a parte que o servidor monta
 * sozinho, só com ids — `deal-rooms/<sala>`, `sivc/<id>/<verificação>`,
 * `contexts/<openId>/<contexto>`, `contacts/<openId>`,
 * `meetings/<openId>/<reunião>` — e por isso é a parte que pode ser escrita.
 */
export function pastaDaChave(chave: string): string {
  const corte = chave.lastIndexOf("/");
  return corte > 0 ? chave.slice(0, corte) : "(raiz do bucket)";
}

/**
 * A impressão digital da chave: o SHA-256 dela, cortado em 16 dígitos. Serve
 * para ACHAR o objeto sem escrever o nome dele — quem for limpar o bucket lista
 * a pasta, calcula o mesmo hash de cada chave que encontrar lá e apaga as que
 * baterem. Não é segredo, é identificação: duas chaves diferentes na mesma pasta
 * têm impressões diferentes, e é disso que o serviço precisa.
 */
export function impressaoDaChave(chave: string): string {
  return createHash("sha256").update(chave).digest("hex").slice(0, 16);
}

/**
 * O pedaço do registro de auditoria que diz O QUE ficou no bucket — pasta,
 * quantos objetos em cada uma e a impressão digital de cada chave. Nunca a chave
 * inteira.
 *
 * Duas revisões, duas correções. A primeira (15/09) mostrou que a contagem
 * sozinha não serve: contagem não apaga arquivo, e quem for limpar o bucket à
 * mão depois precisa saber ONDE está o objeto — nesse momento as linhas do banco
 * que apontavam para cada um já saíram junto com a conta. A segunda (o revisor,
 * no mesmo dia) mostrou que a lista de chaves cruas, que entrou como remédio,
 * carrega dado pessoal: o comentário anterior afirmava que a chave "não carrega
 * nome nem e-mail", e isso é FALSO para três dos cinco prefixos, porque o nome
 * do arquivo enviado vira parte da chave —
 * `deal-rooms/<sala>/<carimbo>-<nome do arquivo>` (routers/dealRoom.ts),
 * `sivc/<id>/<verificação>/<carimbo>-<nome do arquivo>` (routers/sivc.ts) e
 * `contexts/<openId>/<contexto>/<nome do arquivo>` (routers/contexts.ts).
 * "rg-ana-souza.jpg" diz o documento e a pessoa; um contrato anexado na sala diz
 * as duas partes. `audit_logs` é imutável por desenho e sobrevive à conta, então
 * gravar isso seria deixar dado pessoal da usuária no banco DEPOIS de ela pedir
 * a exclusão — exatamente o que esta rota existe para impedir.
 *
 * Pelo lado seguro, então: a pasta (só ids) fica escrita, o nome do arquivo vira
 * hash. O serviço continua possível — listar a pasta, hashear, comparar — e o
 * registro não vaza conteúdo. A chave inteira ainda existe no `console.error` do
 * processo (server/exclusao-de-conta.ts), que é log operacional de curta vida,
 * não registro permanente em banco.
 */
export function chavesParaAuditoria(chaves: string[]): Record<string, unknown> {
  if (!chaves.length) return {};
  const porPasta = new Map<string, number>();
  for (const chave of chaves) {
    const pasta = pastaDaChave(chave);
    porPasta.set(pasta, (porPasta.get(pasta) ?? 0) + 1);
  }
  const pastas: [string, number][] = [];
  porPasta.forEach((arquivos, pasta) => pastas.push([pasta, arquivos]));
  pastas.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const pastasGravadas = pastas.slice(0, TETO_DE_CHAVES_NA_AUDITORIA);
  const impressoes = chaves.slice(0, TETO_DE_CHAVES_NA_AUDITORIA).map(impressaoDaChave);
  return {
    pastasQueFicaramNoBucket: pastasGravadas.map(([pasta, arquivos]) => ({ pasta, arquivos })),
    impressoesDasChaves: impressoes,
    ...(pastas.length > pastasGravadas.length ? { pastasOmitidas: pastas.length - pastasGravadas.length } : {}),
    ...(chaves.length > impressoes.length ? { chavesOmitidas: chaves.length - impressoes.length } : {}),
  };
}

export function confirmacaoEsperada(email: string | null | undefined): string {
  const limpo = (email ?? "").trim();
  return limpo ? limpo.toLowerCase() : PALAVRA_DE_CONFIRMACAO;
}

export function confirmacaoConfere(email: string | null | undefined, digitado: string): boolean {
  return digitado.trim().toLowerCase() === confirmacaoEsperada(email).toLowerCase();
}

export const contaRouter = router({
  /**
   * O que a tela precisa saber ANTES de oferecer o botão: o que digitar, se a
   * conta tem senha para conferir e se ela é a última administradora. Assim o
   * aviso aparece na tela em vez de virar erro depois de digitar tudo.
   */
  requisitosDaExclusao: protectedProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    const [outras] = await db.select({ total: sql<number>`COUNT(*)` })
      .from(users)
      .where(and(
        inArray(users.role, [...PAPEIS_DE_GOVERNANCA]),
        // Conta desativada não governa nada: ela não entra (o
        // `sdk.authenticateRequest` recusa conta inativa) e reativá-la exige um
        // procedimento de admin. Sem este filtro, a última administradora ATIVA
        // se apaga achando que deixou outra no lugar.
        eq(users.isActive, true),
        sql`${users.id} <> ${ctx.user.id}`,
      ));
    const souGovernanca = (PAPEIS_DE_GOVERNANCA as readonly string[]).includes(ctx.user.role);
    return {
      confirmacaoEsperada: confirmacaoEsperada(ctx.user.email),
      temSenha: Boolean(ctx.user.passwordHash),
      ultimaAdministradora: souGovernanca && Number(outras?.total ?? 0) === 0,
    };
  }),

  excluirMinhaConta: protectedProcedure
    .input(z.object({
      senha: z.string().min(1).max(200),
      confirmacao: z.string().min(1).max(320),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      const ipAddress = getRequestIp(ctx.req.headers["x-forwarded-for"], ctx.req.ip);
      const userAgent = ctx.req.headers["user-agent"];

      const inicioDaJanela = new Date(Date.now() - JANELA_DE_TENTATIVAS_MS);
      const [tentativas] = await db.select({ total: sql<number>`COUNT(*)` })
        .from(auditLogs)
        .where(and(
          eq(auditLogs.userId, ctx.user.id),
          eq(auditLogs.action, ACAO_EXCLUSAO_RECUSADA),
          sql`${auditLogs.createdAt} >= ${inicioDaJanela}`,
        ));
      if (Number(tentativas?.total ?? 0) >= LIMITE_DE_TENTATIVAS) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Muitas tentativas de exclusão. Espere 15 minutos e tente de novo.",
        });
      }

      // Trava 1: a confirmação digitada. Erro de digitação não vira tentativa
      // registrada — só a senha errada vira.
      if (!confirmacaoConfere(ctx.user.email, input.confirmacao)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Para confirmar, digite exatamente: ${confirmacaoEsperada(ctx.user.email)}`,
        });
      }

      // Trava 2: a senha. Sem hash não há o que conferir, e apagar tudo sem
      // conferir nada é justamente o que este procedimento não pode fazer.
      if (!ctx.user.passwordHash) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Esta conta não tem senha cadastrada. Use \"Esqueci minha senha\" para criar uma e depois volte para excluir a conta.",
        });
      }
      const bcrypt = await import("bcryptjs");
      const senhaConfere = await bcrypt.compare(input.senha, ctx.user.passwordHash);
      if (!senhaConfere) {
        await createAuditLog({
          userId: ctx.user.id,
          action: ACAO_EXCLUSAO_RECUSADA,
          resource: "conta",
          ipAddress,
          userAgent,
          status: "failure",
          riskLevel: "medium",
        });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Senha incorreta." });
      }

      // Trava 3: a última administradora.
      const souGovernanca = (PAPEIS_DE_GOVERNANCA as readonly string[]).includes(ctx.user.role);
      if (souGovernanca) {
        const [outras] = await db.select({ total: sql<number>`COUNT(*)` })
          .from(users)
          .where(and(
            inArray(users.role, [...PAPEIS_DE_GOVERNANCA]),
            eq(users.isActive, true),
            sql`${users.id} <> ${ctx.user.id}`,
          ));
        if (Number(outras?.total ?? 0) === 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Você é o último administrador da plataforma. Promova outro membro a Ouro antes de excluir sua conta.",
          });
        }
      }

      const relatorio = await excluirConta(db, {
        id: ctx.user.id,
        openId: ctx.user.openId,
        email: ctx.user.email,
      });

      // O registro da exclusão nasce DEPOIS de apagar: o passo de `audit_logs`
      // levaria embora uma linha escrita antes. `details` não guarda nome nem
      // e-mail — contagens, nomes de tabela e, dos objetos que o bucket recusou
      // apagar, a pasta e a impressão digital da chave, nunca a chave inteira
      // (o porquê está em `chavesParaAuditoria`).
      await createAuditLog({
        userId: ctx.user.id,
        action: ACAO_EXCLUSAO,
        resource: "conta",
        details: {
          linhasApagadas: relatorio.linhasApagadas,
          arquivosApagados: relatorio.arquivosApagados,
          arquivosComFalha: relatorio.arquivosComFalha.length,
          ...chavesParaAuditoria(relatorio.arquivosComFalha),
          passos: relatorio.passos.map(passo => `${passo.nome}=${passo.linhas}`),
          // A revogação do token da Google Agenda (H16b): "falhou" quer dizer que
          // a Google não confirmou; a conexão saiu do banco assim mesmo.
          googleAgenda: relatorio.googleAgenda,
        },
        ipAddress,
        userAgent,
        // Algo ficou fora do nosso alcance (objeto no bucket, token na Google):
        // o registro diz "failure", sem esconder que a conta saiu.
        status: relatorio.arquivosComFalha.length || relatorio.googleAgenda === "falhou" ? "failure" : "success",
        riskLevel: "high",
      });

      // As sessões saíram no plano, então o JWT do navegador já não resolve;
      // o cookie sai também para a próxima requisição não chegar como "sessão
      // inválida" e sim como visitante.
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });

      return {
        sucesso: true as const,
        linhasApagadas: relatorio.linhasApagadas,
        arquivosApagados: relatorio.arquivosApagados,
        arquivosComFalha: relatorio.arquivosComFalha.length,
      };
    }),
});
