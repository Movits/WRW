import { rotaDoDocumento } from "@shared/documento-da-reuniao";

/**
 * O envio do PDF da reunião de documento (H12 e H12b): POST binário à rota do
 * servidor (server/_core/rota-do-documento.ts), que autentica antes de ler o
 * corpo e responde JSON com um `codigo`. 202: aceito, a IA lê em segundo
 * plano; 200: o mesmo arquivo já tinha chegado. Qualquer outro desfecho volta
 * com o código, que a tela traduz (mensagemDaRecusaDoDocumento); a falha de
 * rede e a resposta sem JSON viram REDE e ERRO.
 */
export type ResultadoDoEnvioDoDocumento =
  | { tipo: "recebido"; repetido: boolean }
  | { tipo: "recusado"; status: number; codigo: string };

export async function enviarDocumento(meetingId: string, pdf: Blob, buscar: typeof fetch = fetch): Promise<ResultadoDoEnvioDoDocumento> {
  let resposta: Response;
  try {
    resposta = await buscar(rotaDoDocumento(meetingId), {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: pdf,
      credentials: "same-origin",
    });
  } catch {
    return { tipo: "recusado", status: 0, codigo: "REDE" };
  }
  const corpo = await resposta.json().then((c: { codigo?: unknown; repetido?: unknown }) => c, () => null);
  if (resposta.status === 200 || resposta.status === 202) return { tipo: "recebido", repetido: corpo?.repetido === true };
  return { tipo: "recusado", status: resposta.status, codigo: typeof corpo?.codigo === "string" ? corpo.codigo : "ERRO" };
}

/**
 * Os bytes do PDF guardado, para o leitor da tela (o GET da mesma rota). Só a
 * dona recebe; vencido ou excluído é 404. Lança com o código no `message`,
 * para a tela decidir entre "o arquivo já saiu" e "tente de novo".
 */
export class FalhaAoBuscarODocumento extends Error {
  constructor(readonly status: number, readonly codigo: string) {
    super(codigo);
    this.name = "FalhaAoBuscarODocumento";
  }
}

export async function buscarDocumentoGuardado(meetingId: string, buscar: typeof fetch = fetch): Promise<ArrayBuffer> {
  let resposta: Response;
  try {
    resposta = await buscar(rotaDoDocumento(meetingId), { credentials: "same-origin" });
  } catch {
    throw new FalhaAoBuscarODocumento(0, "REDE");
  }
  if (resposta.status === 200) return resposta.arrayBuffer();
  const corpo = await resposta.json().then((c: { codigo?: unknown }) => c, () => null);
  throw new FalhaAoBuscarODocumento(resposta.status, typeof corpo?.codigo === "string" ? corpo.codigo : "ERRO");
}
