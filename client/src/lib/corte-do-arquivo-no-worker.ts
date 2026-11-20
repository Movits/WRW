import { corteCancelado, lerBlob, type CorteDoArquivo } from "./corte-comum";
import type { RespostaDoCorte } from "./corte-do-arquivo";

export type OpcoesDoCorteNoWorker = {
  /** A leitura andou: quantos bytes do arquivo já foram lidos, de quantos. */
  aoLer?: (lidos: number, total: number) => void;
  /** Cancelar encerra o Worker e rejeita com AbortError. */
  sinal?: AbortSignal;
};

/**
 * O corte na página, sem Worker. O módulo dos cortes (com o mp4box) chega só
 * aqui, por import(): a página das reuniões não o carrega para quem nunca
 * importa um arquivo, e o Worker tem o dele.
 */
const naPagina = async (arquivo: Blob, opcoes: OpcoesDoCorteNoWorker) => {
  const { cortarArquivo } = await import("./corte-do-arquivo");
  return cortarArquivo(lerBlob(arquivo), arquivo.size, opcoes);
};

/**
 * Corta o arquivo importado (lib/corte-do-arquivo.ts) num Worker em módulo
 * (workers/corte-do-arquivo.worker.ts), para a tela não travar enquanto um
 * arquivo de horas é lido. O File vai ao Worker por cópia estruturada, que
 * não copia o áudio.
 *
 * Sem Worker (navegador antigo, sem Worker em módulo; o Worker que não
 * carrega antes de responder), o mesmo corte roda na página: ele lê em blocos
 * e devolve a vez à tela entre um bloco e outro. O erro do Worker depois de
 * ele já ter respondido (a leitura que falhou no meio) é falha de leitura.
 */
export function cortarArquivoNoWorker(arquivo: Blob, opcoes: OpcoesDoCorteNoWorker = {}): Promise<CorteDoArquivo> {
  if (opcoes.sinal?.aborted) return Promise.reject(corteCancelado());
  let worker: Worker;
  try {
    worker = new Worker(new URL("../workers/corte-do-arquivo.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return naPagina(arquivo, opcoes);
  }
  return new Promise<CorteDoArquivo>((resolver, rejeitar) => {
    let respondeu = false;
    const soltar = () => {
      worker.terminate();
      opcoes.sinal?.removeEventListener("abort", aoCancelar);
    };
    function aoCancelar() {
      soltar();
      rejeitar(corteCancelado());
    }
    opcoes.sinal?.addEventListener("abort", aoCancelar, { once: true });
    worker.onmessage = (evento: MessageEvent<RespostaDoCorte>) => {
      respondeu = true;
      const resposta = evento.data;
      if (resposta.tipo === "lendo") {
        opcoes.aoLer?.(resposta.lidos, resposta.total);
        return;
      }
      soltar();
      if (resposta.tipo === "pronto") resolver(resposta.corte);
      else rejeitar(new Error("Não foi possível ler o arquivo de áudio."));
    };
    worker.onerror = evento => {
      evento.preventDefault();
      soltar();
      if (respondeu) {
        rejeitar(new Error("Não foi possível ler o arquivo de áudio."));
        return;
      }
      naPagina(arquivo, opcoes).then(resolver, rejeitar);
    };
    worker.postMessage({ arquivo });
  });
}
