import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { liberarTodas } from "@/lib/sessao-ocupada";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

/**
 * Prefixo das chaves do rascunho do cadastro (localStorage e sessionStorage): pages/Onboarding.tsx
 * grava uma por usuária (`<prefixo><id>`). Vive aqui, e não na página, porque
 * o Onboarding é carregado com `lazy` e o logout precisa do prefixo sem puxar
 * a página inteira para o bundle principal.
 */
export const PREFIXO_DO_RASCUNHO_DO_CADASTRO = "mmm.onboarding.rascunho.";

/**
 * Apaga todo rascunho do cadastro deste navegador. Sair da conta é o momento:
 * em computador compartilhado, o rascunho de uma conta não pode ficar à
 * espera de quem entrar depois (mesma razão da nota V-03 abaixo). Sem
 * armazenamento (modo privado, SSR), nada a apagar.
 */
export function apagarRascunhosDoCadastro() {
  // O localStorage guarda o rascunho que sobrevive a fechar a aba; o
  // sessionStorage, com a mesma chave, guarda a etapa e os campos que só podem
  // voltar num recarregar da mesma aba (ver "Rascunho do cadastro" no Onboarding).
  for (const armazenamento of ["localStorage", "sessionStorage"] as const) {
    try {
      const area = window[armazenamento];
      const chaves: string[] = [];
      for (let i = 0; i < area.length; i++) {
        const chave = area.key(i);
        if (chave?.startsWith(PREFIXO_DO_RASCUNHO_DO_CADASTRO)) chaves.push(chave);
      }
      for (const chave of chaves) area.removeItem(chave);
    } catch {
      // Sem o armazenamento, ou bloqueado: não há rascunho a apagar nele.
    }
  }
}

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath = getLoginUrl() } =
    options ?? {};
  const utils = trpc.useUtils();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      utils.auth.me.setData(undefined, null);
    },
  });

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        return;
      }
      throw error;
    } finally {
      // No `finally`, como o cache: a sessão do navegador acaba mesmo quando o
      // servidor não respondeu, e o rascunho do cadastro vai junto.
      apagarRascunhosDoCadastro();
      // As ocupações da sessão que sobraram também (lib/sessao-ocupada.ts): no
      // diálogo do Sair a dona já aceitou perder o áudio, e o envio ainda no ar
      // faria o navegador perguntar no login seguinte desta aba.
      liberarTodas();
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [logoutMutation, utils]);

  const state = useMemo(() => {
    // V-03: REMOVIDO - não persistir dados de usuário no localStorage
    // Isso expunha nome, email, role e openId a XSS, extensões maliciosas e computadores compartilhados
    // Os dados de autenticação ficam apenas em memória (React state via tRPC cache)
    return {
      user: meQuery.data ?? null,
      loading: meQuery.isLoading || logoutMutation.isPending,
      // `error` é como quem consome distingue "não autenticada" (data null,
      // ou UNAUTHED_ERR_MSG) de "não deu para verificar" (banco de dados fora
      // do ar, servidor inacessível): auth.me lança nesse caso em vez de
      // devolver null, e a mensagem chega aqui em error.message. Quem trata
      // é o ProtectedRoute; aqui só se garante que o erro não se perde.
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
    };
  }, [
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
    logoutMutation.error,
    logoutMutation.isPending,
  ]);

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutMutation.isPending) return;
    if (state.user) return;
    // A query falhou por outro motivo que não "sem sessão": a usuária pode
    // estar logada, só não deu para saber. Mandar para o login a expulsaria.
    if (meQuery.error && meQuery.error.message !== UNAUTHED_ERR_MSG) return;
    if (typeof window === "undefined") return;
    if (window.location.pathname === redirectPath) return;

    // Usar replace para navegação suave sem recarregar a página
    window.location.replace(redirectPath);
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    logoutMutation.isPending,
    meQuery.isLoading,
    meQuery.error,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
