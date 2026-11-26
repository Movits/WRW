import type { ReactNode } from "react";
import { noAppDasLojas } from "@/lib/instalacao-do-app";

/**
 * Mostra o conteúdo só fora do app das lojas. Serve para os subtítulos e as
 * descrições que explicam o produto: dentro do app, as telas ficam só com as
 * funções (pedido da Glenda em 11/11), e a explicação fica no site e nas lojas.
 *
 * Não use para aviso de consentimento, de privacidade, de erro ou de prazo:
 * esses aparecem também no app.
 */
export function SoNoNavegador({ children }: { children: ReactNode }) {
  if (noAppDasLojas()) return null;
  return <>{children}</>;
}
