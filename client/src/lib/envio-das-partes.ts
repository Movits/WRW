import { apagarParte, parteNoAparelho, partesGuardadas, type ParteNoAparelho } from "./partes-no-aparelho";

/**
 * O envio das partes da gravação (G9 do desenho do gravador): cada parte vai
 * por POST binário à rota do servidor (server/_core/rota-das-partes.ts) e só
 * sai do aparelho quando o servidor a confirma.
 *
 * O servidor responde JSON com um `codigo`. 200/201: recebida. 429, 503, 5xx,
 * resposta sem JSON e falha de rede: passageira, e a parte fica para depois.
 * 401 e 403: a sessão acabou ou o cadastro está incompleto; a parte fica
 * guardada e vai depois do novo login. Os
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
  // 401 e 403 (sessão vencida, cadastro ainda incompleto) se resolvem depois de
  // entrar de novo: a parte fica guardada, nunca é tratada como recusa.
  if (resposta.status === 401 || resposta.status === 403) return { tipo: "sem-sessao" };
  if (resposta.status === 429 || resposta.status >= 500 || codigo === undefined) return { tipo: "passageira", codigo };
  return { tipo: "recusada", codigo };
}

export type Trava = <T>(nome: string, trabalho: () => Promise<T>) => Promise<T | null>;

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
 *
 * `pular` diz as gravações que não sobem agora (G13c): a descartada, cuja
 * cópia ainda não saiu do aparelho. Elas nem contam como áudio por enviar, e a
 * pergunta se repete a cada parte, porque o Descartar pode chegar no meio.
 *
 * Duas retomadas (a da tela de Reuniões e a de toda tela logada, ou as de duas
 * abas) podem ler a lista ao mesmo tempo. Por isso cada parte é conferida de
 * novo já com a trava da reunião: a que a outra enviou e apagou depois da
 * leitura não sobe outra vez.
 */
export async function enviarPendentes(dona: string, opcoes: { buscar?: typeof fetch; trava?: Trava; aoRecusar?: (parte: ParteNoAparelho, codigo?: string) => void; pular?: (meetingId: string) => boolean } = {}): Promise<{ restantes: number; semSessao: boolean }> {
  const trava = opcoes.trava ?? travaDoNavegador;
  const pular = opcoes.pular ?? (() => false);
  const partes = await partesGuardadas(dona);
  const porReuniao = new Map<string, ParteNoAparelho[]>();
  for (const p of partes) porReuniao.set(p.meetingId, [...(porReuniao.get(p.meetingId) ?? []), p]);
  let restantes = 0;
  let semSessao = false;
  for (const [meetingId, lista] of Array.from(porReuniao.entries())) {
    if (pular(meetingId)) continue;
    const enviadas = await trava(`wrw-envio-${meetingId}`, async () => {
      let n = 0;
      for (const parte of lista) {
        // Descartada no meio: o resto fica para a exclusão, e não conta.
        if (pular(meetingId)) return lista.length;
        // Sem como conferir (o IndexedDB bloqueado por outra aba), envia: o
        // servidor aceita o reenvio da mesma parte sem duplicar.
        if (!(await parteNoAparelho(meetingId, parte.seq).catch(() => true))) {
          n += 1;
          continue;
        }
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
