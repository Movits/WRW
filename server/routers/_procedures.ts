import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "../_core/trpc";

// ============================================================
// PROCEDURES DE ACESSO
// ============================================================
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" && ctx.user.role !== "president" && ctx.user.role !== "gold") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso restrito a administradores" });
  }
  return next({ ctx });
});

// Ouro = Presidente: qualquer membra Ouro tem acesso ao painel de governança
export const presidentProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "president" && ctx.user.role !== "gold" && ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso restrito a membros com Status Ouro." });
  }
  return next({ ctx });
});

export const goldProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "gold" && ctx.user.role !== "admin" && ctx.user.role !== "president") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso restrito a membros com Status Ouro." });
  }
  return next({ ctx });
});

/**
 * A rastreabilidade das conexões é da PLATAFORMA, e a plataforma aqui é a
 * staff: admin e presidente — a mesma régua de `isStaff` em
 * oportunidade-acesso.ts. Serve também à consulta das reuniões (R1a,
 * routers/consultaDeReunioes.ts): a 5ª exceção ao "Ouro = Presidente".
 * Não é o `adminProcedure`, que aceita Ouro: Ouro é a categoria premium paga
 * (Governança, 14/09), e a lista atravessa a rede particular de TODAS as donas
 * (o que os contatos têm e procuram, e qual conta responde por cada ID anônimo), por fora das travas do acervo Ouro (nível
 * 'ouro' no contato, termo da dona, GOLD_ACERVO_READ).
 */
export const plataformaProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" && ctx.user.role !== "president") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso restrito à administração da plataforma." });
  }
  return next({ ctx });
});

// Distribuidor do Smart Match: a pessoa real que confere cada pedido de interesse
// antes de encaminhá-lo. É um PODER da conta (`users.isDistributor`), não um nível:
// Ouro, presidente ou admin SEM a flag levam 403 aqui, e uma Prata COM a flag passa.
// `ctx.user` é a linha de `users` lida a cada requisição, então revogar o poder vale
// na chamada seguinte, sem consulta extra.
export const distribuidorProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.isDistributor !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso restrito ao distribuidor do Smart Match." });
  }
  return next({ ctx });
});

// A conta de uma ENTIDADE (a base das associações, N1): também um PODER
// (`users.isEntidade`), não um nível. A flag só abre a porta; o procedimento
// ainda lê a linha de `entidades` da própria conta (`entidadeDaConta`), e sem
// ela responde FORBIDDEN. Conta da equipe nunca vira entidade (criarEntidade).
export const entidadeProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.isEntidade !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "ENTIDADE_NAO_ENCONTRADA" });
  }
  return next({ ctx });
});
