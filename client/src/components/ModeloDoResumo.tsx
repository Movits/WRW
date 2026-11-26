import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { mensagemDoErroDaIA } from "@/components/ReuniaoComIA";
import {
  ESCOLHA_DA_IA, ESTILO_DO_RESUMO_PADRAO, ESTILOS_DO_RESUMO, INSTRUCOES_DO_PEDIDO_MAX, MODELOS_DE_RESUMO, RECUSAS_DOS_MODELOS, escolhaDoTexto,
  type EstiloDoResumo, type ModeloDeResumo,
} from "@shared/modelos-de-resumo";

/**
 * Os modelos do resumo guardado (H4d do plano do gravador): Geral, Networking,
 * Mentoria, Vendas e 1:1, com as mesmas seções e outra instrução à IA
 * (server/modelos-de-resumo.ts). Só a dona escolhe: ao pedir o resumo que a
 * reunião ainda não tem (EscolhaDoModelo) e no "Refazer como…"
 * (PainelDeRefazer), que guarda os itens confirmados e as ações feitas e troca
 * os pendentes e os ignorados. O link aberto não mostra nada disto.
 *
 * H4e: também os modelos da própria dona, "a IA escolhe o modelo", o estilo
 * (conciso, equilibrado ou detalhado) e as instruções do pedido
 * (OpcoesDoResumo), e a pergunta "O resumo teve o tamanho certo?"
 * (PerguntaDoTamanho). Os modelos dela e o padrão se cuidam em
 * MeusModelosDeResumo.tsx.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

// Cada ramo chama t() com a chave literal, para o teste das chaves usadas
// (server/i18n-chaves-usadas.test.ts) conferir que todas existem.
export function nomeDoModelo(t: TranslateFn, modelo: ModeloDeResumo): string {
  switch (modelo) {
    case "general": return t("meetings.summary.templateGeneral");
    case "networking": return t("meetings.summary.templateNetworking");
    case "mentoring": return t("meetings.summary.templateMentoring");
    case "sales": return t("meetings.summary.templateSales");
    case "one_on_one": return t("meetings.summary.templateOneOnOne");
  }
}

function dicaDoModelo(t: TranslateFn, modelo: ModeloDeResumo): string {
  switch (modelo) {
    case "general": return t("meetings.summary.templateGeneralHint");
    case "networking": return t("meetings.summary.templateNetworkingHint");
    case "mentoring": return t("meetings.summary.templateMentoringHint");
    case "sales": return t("meetings.summary.templateSalesHint");
    case "one_on_one": return t("meetings.summary.templateOneOnOneHint");
  }
}

export function nomeDoEstilo(t: TranslateFn, estilo: EstiloDoResumo): string {
  switch (estilo) {
    case "concise": return t("meetings.summary.styleConcise");
    case "balanced": return t("meetings.summary.styleBalanced");
    case "detailed": return t("meetings.summary.styleDetailed");
  }
}

/** Um modelo da dona como a tela o recebe (meetings.modelosDeResumo). */
export type ModeloProprioNaTela = { id: string; nome: string; icone: string; instrucoes: string };

/** O pedido do resumo na tela: o modelo como texto ("sales", "ia", "proprio:<id>"), o estilo e as instruções. */
export type PedidoNaTela = { modelo: string; estilo: EstiloDoResumo; instrucoes: string };

export const PEDIDO_PADRAO: PedidoNaTela = { modelo: "general", estilo: ESTILO_DO_RESUMO_PADRAO, instrucoes: "" };

/**
 * O que vai à mutação: o estilo só quando não é o equilibrado e as instruções
 * só quando há texto (sem elas, o pedido é o de antes da H4e).
 */
export function pedidoParaEnviar(pedido: PedidoNaTela): { modelo: string; estilo?: EstiloDoResumo; instrucoes?: string } {
  const instrucoes = pedido.instrucoes.trim();
  return {
    modelo: pedido.modelo,
    ...(pedido.estilo !== ESTILO_DO_RESUMO_PADRAO ? { estilo: pedido.estilo } : {}),
    ...(instrucoes ? { instrucoes } : {}),
  };
}

/** Os modelos da dona e as preferências dela; só para a dona (nunca pelo link). */
export function useModelosDaDona(ligado = true) {
  return trpc.meetings.modelosDeResumo.useQuery(undefined, { enabled: ligado, staleTime: 60_000 });
}

/** O nome da escolha na tela: o pronto, o da dona (com o ícone) ou "A IA escolhe". */
export function nomeDaEscolha(t: TranslateFn, texto: string | null | undefined, proprios: readonly ModeloProprioNaTela[] = []): string {
  const escolha = escolhaDoTexto(texto);
  if (!escolha) return nomeDoModelo(t, "general");
  if (escolha.tipo === "ia") return t("meetings.summary.templateAi");
  if (escolha.tipo === "pronto") return nomeDoModelo(t, escolha.modelo);
  const proprio = proprios.find(modelo => modelo.id === escolha.id);
  return proprio ? `${proprio.icone} ${proprio.nome}` : nomeDoModelo(t, "general");
}

function dicaDaEscolha(t: TranslateFn, texto: string, proprios: readonly ModeloProprioNaTela[]): string {
  const escolha = escolhaDoTexto(texto);
  if (!escolha) return dicaDoModelo(t, "general");
  if (escolha.tipo === "ia") return t("meetings.summary.templateAiHint");
  if (escolha.tipo === "pronto") return dicaDoModelo(t, escolha.modelo);
  return t("meetings.summary.templateOwnHint");
}

/** As opções do seletor do modelo: os prontos, os da dona e "A IA escolhe". */
function OpcoesDoSeletor({ proprios }: { proprios: readonly ModeloProprioNaTela[] }) {
  const { t } = useTranslation();
  const prontos = MODELOS_DE_RESUMO.map(modelo => <option key={modelo} value={modelo}>{nomeDoModelo(t, modelo)}</option>);
  if (!proprios.length) return <>{prontos}<option value={ESCOLHA_DA_IA}>{t("meetings.summary.templateAi")}</option></>;
  return <>
    <optgroup label={t("meetings.summary.templateGroupReady")}>{prontos}</optgroup>
    <optgroup label={t("meetings.summary.templateGroupOwn")}>
      {proprios.map(modelo => <option key={modelo.id} value={`proprio:${modelo.id}`}>{modelo.icone} {modelo.nome}</option>)}
    </optgroup>
    <option value={ESCOLHA_DA_IA}>{t("meetings.summary.templateAi")}</option>
  </>;
}

/**
 * O estilo e as instruções do pedido (H4e), embaixo do modelo: o mesmo bloco
 * no pedido, no refazer e antes de gravar.
 */
export function EstiloEInstrucoes({ valor, aoMudar, desligado = false }: { valor: PedidoNaTela; aoMudar: (pedido: PedidoNaTela) => void; desligado?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-3">
    <fieldset className="min-w-0">
      <legend className="text-xs font-semibold text-white/60">{t("meetings.summary.styleLabel")}</legend>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {ESTILOS_DO_RESUMO.map(estilo => <label key={estilo} className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${valor.estilo === estilo ? "border-amber-300/60 bg-amber-300/10 text-amber-100" : "border-white/15 text-white/70"}`}>
          <input type="radio" name={`${id}-estilo`} value={estilo} checked={valor.estilo === estilo} disabled={desligado}
            onChange={() => aoMudar({ ...valor, estilo })} className="h-3.5 w-3.5 accent-amber-400"/>
          {nomeDoEstilo(t, estilo)}
        </label>)}
      </div>
    </fieldset>
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`${id}-instrucoes`} className="text-xs font-semibold text-white/60">{t("meetings.summary.instructionsLabel")}</label>
      <textarea id={`${id}-instrucoes`} value={valor.instrucoes} disabled={desligado} maxLength={INSTRUCOES_DO_PEDIDO_MAX} rows={2}
        aria-describedby={`${id}-instrucoes-dica`} placeholder={t("meetings.summary.instructionsPlaceholder")}
        onChange={evento => aoMudar({ ...valor, instrucoes: evento.target.value })}
        className="w-full min-w-0 resize-y rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white outline-none focus:border-amber-300 disabled:opacity-60"/>
      <p id={`${id}-instrucoes-dica`} className="text-xs text-white/45">{t("meetings.summary.instructionsHint")}</p>
    </div>
  </div>;
}

/**
 * O modelo do resumo que a reunião ainda não tem, escolhido antes de pedir: o
 * rótulo, o seletor com o botão de pedir ao lado (children) e a descrição do
 * modelo escolhido embaixo; depois, o estilo e as instruções (H4e).
 */
export function EscolhaDoModelo({ valor, aoMudar, desligado = false, proprios = [], children }: {
  valor: PedidoNaTela; aoMudar: (pedido: PedidoNaTela) => void; desligado?: boolean; proprios?: readonly ModeloProprioNaTela[]; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-3">
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`${id}-modelo`} className="text-xs font-semibold text-white/60">{t("meetings.summary.templateLabel")}</label>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <select id={`${id}-modelo`} value={valor.modelo} disabled={desligado} aria-describedby={`${id}-dica`}
          onChange={evento => aoMudar({ ...valor, modelo: evento.target.value })}
          className="w-full min-w-0 rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white outline-none focus:border-amber-300 disabled:opacity-60 sm:w-56">
          <OpcoesDoSeletor proprios={proprios}/>
        </select>
        {children}
      </div>
      <p id={`${id}-dica`} className="text-xs text-white/45">{dicaDaEscolha(t, valor.modelo, proprios)}</p>
    </div>
    <EstiloEInstrucoes valor={valor} aoMudar={aoMudar} desligado={desligado}/>
  </div>;
}

// A recusa de refazer o resumo que ainda está na fila em outro modelo
// (CONFLICT) diz o que está acontecendo: a IA já está escrevendo. O teto de
// custo do refazer (H4e) tem a frase dele; as outras recusas (o teto de
// pedidos, o banco fora do ar) seguem a regra das chamadas à IA.
export function mensagemDoRefazer(t: TranslateFn, erro: unknown) {
  const { data, message } = (erro ?? {}) as { data?: { code?: string }; message?: unknown };
  if (data?.code === "CONFLICT") return t("meetings.summary.generating");
  if (message === RECUSAS_DOS_MODELOS.refazeresDemais) return t("meetings.summary.errorRedoTooMany");
  if (message === RECUSAS_DOS_MODELOS.naoEncontrado) return t("meetings.summary.myTemplates.errorNotFound");
  return mensagemDoErroDaIA(t, erro, t("meetings.summary.requestError"), false);
}

/**
 * "Refazer como…": a dona escolhe o modelo (o atual vem marcado: refazer nele
 * dá uma versão nova), o estilo e as instruções, e manda refazer. A fila
 * guarda os itens confirmados e as ações feitas e troca o resto; até lá, a
 * tela mostra a versão anterior só para ler. Aceito o pedido, o painel fecha e
 * o resumo é relido. Diz quantos refazeres ainda cabem nas 24 h (H4e).
 */
export function PainelDeRefazer({ id, meetingId, atual, aoFechar }: { id: string; meetingId: string; atual: PedidoNaTela | ModeloDeResumo; aoFechar: () => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const prefixo = useId();
  const modelos = useModelosDaDona();
  const proprios = modelos.data?.proprios ?? [];
  const [escolhido, setEscolhido] = useState<PedidoNaTela>(typeof atual === "string" ? { ...PEDIDO_PADRAO, modelo: atual } : atual);
  const refazer = trpc.meetings.refazerResumo.useMutation({
    onSuccess: aoFechar,
    onSettled: () => {
      void utils.meetings.modelosDeResumo?.invalidate?.();
      return utils.meetings.resumoGuardado.invalidate({ meetingId });
    },
  });
  const opcoes: Array<{ valor: string; nome: string; dica: string }> = [
    ...MODELOS_DE_RESUMO.map(modelo => ({ valor: modelo, nome: nomeDoModelo(t, modelo), dica: dicaDoModelo(t, modelo) })),
    ...proprios.map(modelo => ({ valor: `proprio:${modelo.id}`, nome: `${modelo.icone} ${modelo.nome}`, dica: t("meetings.summary.templateOwnHint") })),
    { valor: ESCOLHA_DA_IA, nome: t("meetings.summary.templateAi"), dica: t("meetings.summary.templateAiHint") },
  ];
  const restam = modelos.data?.refazeresQueRestam;
  return <div id={id} className="mt-4 rounded-xl border border-amber-300/25 bg-black/20 p-4">
    <fieldset>
      <legend className="text-sm font-semibold text-amber-100">{t("meetings.summary.templateLabel")}</legend>
      <div className="mt-3 space-y-3">
        {opcoes.map((opcao, i) => <div key={opcao.valor} className="flex items-start gap-3">
          <input type="radio" id={`${prefixo}-${i}`} name={`${prefixo}-modelo`} value={opcao.valor} checked={escolhido.modelo === opcao.valor}
            onChange={() => setEscolhido({ ...escolhido, modelo: opcao.valor })} disabled={refazer.isPending} aria-describedby={`${prefixo}-${i}-dica`}
            className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <div className="min-w-0">
            <label htmlFor={`${prefixo}-${i}`} className="cursor-pointer break-words text-sm font-semibold text-white/90">{opcao.nome}</label>
            <p id={`${prefixo}-${i}-dica`} className="text-xs text-white/50">{opcao.dica}</p>
          </div>
        </div>)}
      </div>
    </fieldset>
    <div className="mt-4"><EstiloEInstrucoes valor={escolhido} aoMudar={setEscolhido} desligado={refazer.isPending}/></div>
    <p className="mt-4 text-xs text-amber-100/75">{t("meetings.summary.redoNotice")}</p>
    {typeof restam === "number" && <p className="mt-2 text-xs text-white/50">{t("meetings.summary.redoLeft", { n: restam })}</p>}
    {refazer.isError && <p role="alert" className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoRefazer(t, refazer.error)}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={refazer.isPending} onClick={() => refazer.mutate({ meetingId, ...pedidoParaEnviar(escolhido) })}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
        {refazer.isPending ? <Loader2 size={15} className="animate-spin"/> : <RefreshCw size={15}/>} {t("meetings.summary.redoConfirm")}
      </button>
      <button type="button" onClick={aoFechar} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 hover:text-white">
        {t("meetings.summary.redoCancel")}
      </button>
    </div>
  </div>;
}

/**
 * "O resumo teve o tamanho certo?" (H4e, como no app web do HiNoter): três
 * botões sob o resumo pronto. A resposta ajusta os próximos resumos da dona;
 * tocar de novo na marcada desfaz.
 */
export function PerguntaDoTamanho({ meetingId, resposta }: { meetingId: string; resposta: "short" | "right" | "long" | null }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const responder = trpc.meetings.responderTamanhoDoResumo.useMutation({
    onSettled: () => utils.meetings.resumoGuardado.invalidate({ meetingId }),
  });
  const opcoes = [
    { valor: "short" as const, nome: t("meetings.summary.lengthShort") },
    { valor: "right" as const, nome: t("meetings.summary.lengthRight") },
    { valor: "long" as const, nome: t("meetings.summary.lengthLong") },
  ];
  const id = useId();
  return <div className="flex flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
    <p id={id} className="text-sm text-white/65">{resposta ? t("meetings.summary.lengthThanks") : t("meetings.summary.lengthQuestion")}</p>
    <div role="group" aria-labelledby={id} className="flex flex-wrap gap-2">
      {opcoes.map(opcao => <button key={opcao.valor} type="button" aria-pressed={resposta === opcao.valor} disabled={responder.isPending}
        onClick={() => responder.mutate({ meetingId, resposta: resposta === opcao.valor ? null : opcao.valor })}
        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-60 ${resposta === opcao.valor ? "border-amber-300/60 bg-amber-300/15 text-amber-100" : "border-white/15 text-white/70 hover:text-white"}`}>
        {opcao.nome}
      </button>)}
    </div>
    {responder.isError && <p role="alert" className="text-xs text-red-200">{mensagemDoErroDaIA(t, responder.error, t("meetings.summary.requestError"), false)}</p>}
  </div>;
}

/**
 * O pedido do resumo antes de gravar (H4e, como no HiNoter): o modelo, o
 * estilo e as instruções para esta reunião, recolhidos sob uma linha que diz o
 * escolhido. Sem abrir, valem os padrões da dona. Quem grava manda o pedido ao
 * servidor quando a reunião nasce (meetings.definirPedidoDoResumo).
 */
export function PedidoAntesDeGravar({ valor, aoMudar, desligado = false }: { valor: PedidoNaTela | null; aoMudar: (pedido: PedidoNaTela) => void; desligado?: boolean }) {
  const { t } = useTranslation();
  const modelos = useModelosDaDona();
  const proprios = modelos.data?.proprios ?? [];
  const padrao: PedidoNaTela = modelos.data ? { ...PEDIDO_PADRAO, modelo: modelos.data.padrao, estilo: modelos.data.estilo } : PEDIDO_PADRAO;
  const atual = valor ?? padrao;
  return <details className="rounded-xl border border-white/10 p-4">
    <summary className="cursor-pointer text-sm text-white/70">
      {t("meetings.summary.beforeRecording.title")}: <span className="font-semibold text-white/90">{nomeDaEscolha(t, atual.modelo, proprios)}</span>
    </summary>
    <p className="mt-2 text-xs text-white/45">{t("meetings.summary.beforeRecording.hint")}</p>
    <div className="mt-3"><EscolhaDoModelo valor={atual} aoMudar={aoMudar} desligado={desligado} proprios={proprios}/></div>
  </details>;
}
