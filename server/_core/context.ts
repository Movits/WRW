import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { renovarCookieDaSessao } from "../auth";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "../banco-indisponivel";
import { sdk } from "./sdk";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  /**
   * A sessão não pôde ser lida porque o banco caiu, e não porque não há
   * sessão. Quem consome é o protectedProcedure (server/_core/trpc.ts), que
   * então responde "banco indisponível" em vez de "não autenticada", e o
   * auth.me (routers/auth.ts), que lança em vez de devolver null — null
   * mandaria a usuária logada para o login.
   */
  bancoIndisponivel?: boolean;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;
  let bancoIndisponivel = false;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
    // Banco fora do ar não é "sem sessão". Em produção ele chega como erro do
    // driver na primeira query (getUserByOpenId), não como BancoIndisponivel;
    // ehErroDeBancoIndisponivel reconhece os dois. Não se relança daqui de
    // propósito: os procedimentos públicos (estatísticas da página inicial,
    // login) precisam continuar respondendo; o contexto só anota o motivo.
    if (ehErroDeBancoIndisponivel(error)) {
      bancoIndisponivel = true;
      console.error(`[Auth] Banco de dados indisponível ao ler a sessão: ${descreverErroDeBanco(error)}`);
    }
  }

  // Sessão deslizante (server/duracao-da-sessao.ts): quem está usando o app
  // ganha token e cookie novos uma vez por dia. Fora do try de propósito: uma
  // falha aqui não pode virar "sem sessão" e mandar a usuária para o login.
  if (user) await renovarCookieDaSessao(opts.req, opts.res);

  return {
    req: opts.req,
    res: opts.res,
    user,
    bancoIndisponivel,
  };
}
