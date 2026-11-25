import type { Request } from "express";
import { reuniaoDaCredencial } from "@shared/participantes-da-reuniao";
import { sdk } from "./_core/sdk";
import { ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import type { LeitoraDoLink } from "./senha-do-link-aberto";

/**
 * A conta logada que pede o áudio ou a imagem pela rota do link (fora do
 * tRPC), só quando o endereço traz a credencial da participante (R1b,
 * "participante:<id>"): é a sessão dela que abre a reunião. O link de sempre
 * não lê a sessão. Sem sessão, ou com a sessão recusada, null (a rota responde
 * 404, como ao link desligado); o banco fora do ar segue como erro.
 */
export async function leitoraDaRota(req: Request, token: string): Promise<LeitoraDoLink | null> {
  if (!reuniaoDaCredencial(token)) return null;
  try {
    const conta = await sdk.authenticateRequest(req);
    return { id: conta.id, openId: conta.openId };
  } catch (erro) {
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    return null;
  }
}
