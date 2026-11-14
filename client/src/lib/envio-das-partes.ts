import { apagarParte, partesGuardadas, type ParteNoAparelho } from "./partes-no-aparelho";

/**
 * O envio das partes da gravação (G9 do desenho do gravador): cada parte vai
 * por POST binário à rota do servidor (server/_core/rota-das-partes.ts) e só
 * sai do aparelho quando o servidor a confirma.
 *
 * O servidor responde JSON com um `codigo`. 200/201: recebida. 429, 503, 5xx,
 * resposta sem JSON e falha de rede: passageira, e a parte fica para depois.
 * 401: a sessão acabou; a parte fica guardada e vai depois do novo login. Os
 * outros 4xx são recusa definitiva (reunião excluída, parte além do total...):
 * reenviar não muda nada, e a parte sai do aparelho.
 */

export type ResultadoDoEnvio =
  | { tipo: "recebida" }
  | { tipo: "passageira"; codigo?: string }
  | { tipo: "sem-sessao" }
  | { tipo: "recusada"; codigo?: string };

export const rotaDaParte = (meetingId: string, seq: number) => `/api/reunioes/${encodeURIComponent(meetingId)}/partes/${seq}`;

export async function enviarParte(meetingId: string, seq: number, blob: Blob, mimeType: string, buscar: typeof fetch = fetch): Promise<ResultadoDoEnvio> {
  let resposta: Response;
  try {
    resposta = await buscar(rotaDaParte(meetingId, seq), {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: blob,
      credentials: "same-origin",
    });
  } catch {
    return { tipo: "passageira" };
  }
  if (resposta.status === 200 || resposta.status === 201) return { tipo: "recebida" };
  const codigo = await resposta.json().then((c: { codigo?: unknown }) => (typeof c?.codigo === "string" ? c.codigo : undefined), () => undefined);
  if (resposta.status === 401) return { tipo: "sem-sessao" };
  if (resposta.status === 429 || resposta.status >= 500 || codigo === undefined) return { tipo: "passageira", codigo };
  return { tipo: "recusada", codigo };
}

type Trava = <T>(nome: string, trabalho: () => Promise<T>) => Promise<T | null>;

/**
 * A trava entre abas (Web Locks): duas abas abertas não enviam a mesma
 * gravação ao mesmo tempo. Sem a API (navegador antigo), envia sem trava — o
 * servidor aceita o reenvio da mesma parte sem duplicar.
 */
export const travaDoNavegador: Trava = async (nome, trabalho) => {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: { request: (n: string, o: { ifAvailable: boolean }, f: (lock: unknown) => Promise<unknown>) => Promise<unknown> } }).locks : undefined;
  if (!locks) return trabalho();
  let resultado: Awaited<ReturnType<typeof trabalho>> | null = null;
  await locks.request(nome, { ifAvailable: true }, async lock => {
    // Outra aba já envia esta gravação: esta não faz nada agora.
    if (!lock) return;
    resultado = await trabalho();
  });
  return resultado;
};

/**
 * Manda tudo o que ficou no aparelho desta conta, gravação por gravação, na
 * ordem das partes. Para no primeiro passageiro de cada gravação (a próxima
 * tentativa retoma dali). Devolve o que ainda ficou.
 */
export async function enviarPendentes(dona: string, opcoes: { buscar?: typeof fetch; trava?: Trava; aoRecusar?: (parte: ParteNoAparelho, codigo?: string) => void } = {}): Promise<{ restantes: number; semSessao: boolean }> {
  const trava = opcoes.trava ?? travaDoNavegador;
  const partes = await partesGuardadas(dona);
  const porReuniao = new Map<string, ParteNoAparelho[]>();
  for (const p of partes) porReuniao.set(p.meetingId, [...(porReuniao.get(p.meetingId) ?? []), p]);
  let restantes = 0;
  let semSessao = false;
  for (const [meetingId, lista] of Array.from(porReuniao.entries())) {
    const enviadas = await trava(`wrw-envio-${meetingId}`, async () => {
      let n = 0;
      for (const parte of lista) {
        const r = await enviarParte(meetingId, parte.seq, parte.blob, parte.mimeType, opcoes.buscar);
        if (r.tipo === "recebida" || r.tipo === "recusada") {
          if (r.tipo === "recusada") opcoes.aoRecusar?.(parte, r.codigo);
          await apagarParte(meetingId, parte.seq);
          n += 1;
          continue;
        }
        if (r.tipo === "sem-sessao") semSessao = true;
        break;
      }
      return n;
    });
    restantes += lista.length - (enviadas ?? 0);
  }
  return { restantes, semSessao };
}
