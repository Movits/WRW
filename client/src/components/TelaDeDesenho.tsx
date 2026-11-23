import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eraser, Loader2, Undo2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LADO_MAXIMO_DO_ANEXO } from "@shared/anexos-do-resumo";
import {
  CORES_DA_CANETA, desenharTracos, ESPESSURAS_DA_CANETA, ponteiroDesenha, tamanhoDaImagem, type Pincel, type Traco,
} from "@/lib/desenho";

/**
 * A tela de desenho do resumo (H4h; HN-33 no app de referência da cliente):
 * uma folha branca em que a dona desenha ou escreve à mão com a caneta do iPad
 * (Apple Pencil, com a pressão), o dedo ou o mouse. Guardar vira uma imagem PNG
 * (o traço sobre fundo liso comprime bem e fica nítido), que sobe como anexo do
 * resumo (`tipo: "drawing"`), pelo mesmo caminho das fotos da H4g.
 *
 * Pointer Events cobrem os três ponteiros; `touch-action: none` na folha
 * impede que o traço role a página. Depois que a caneta tocou a folha, o dedo
 * não desenha mais (a palma da mão apoiada no iPad), como no app de referência.
 */

/** A proporção da folha: paisagem, como uma página de caderno deitada (cabe no celular em pé e no iPad). */
const PROPORCAO_DA_FOLHA = 3 / 4;

type Props = {
  aberta: boolean;
  aoFechar: () => void;
  /** Recebe o data: URL do PNG; resolve quando o anexo subiu (a tela fecha), rejeita se não subiu (a folha fica). */
  aoGuardar: (dataUrl: string) => Promise<void>;
};

export function TelaDeDesenho({ aberta, aoFechar, aoGuardar }: Props) {
  const { t } = useTranslation();
  const folha = useRef<HTMLCanvasElement | null>(null);
  const [tracos, setTracos] = useState<Traco[]>([]);
  const tracoAtual = useRef<Traco | null>(null);
  const ponteiroAtivo = useRef<number | null>(null);
  const canetaUsada = useRef(false);
  const [cor, setCor] = useState<string>(CORES_DA_CANETA[0]);
  const [espessura, setEspessura] = useState<number>(ESPESSURAS_DA_CANETA[1]);
  const [tamanho, setTamanho] = useState({ largura: 0, altura: 0 });
  const [guardando, setGuardando] = useState(false);

  // A folha acompanha a largura da caixa (o celular em pé, o iPad deitado). A
  // medida sai quando a caixa monta (o diálogo a põe num portal, depois do
  // primeiro efeito desta tela) e a cada mudança de tamanho da janela.
  const caixa = useRef<HTMLDivElement | null>(null);
  const medir = useCallback(() => {
    const largura = Math.floor(caixa.current?.clientWidth ?? 0);
    if (largura > 0) setTamanho(atual => atual.largura === largura ? atual : { largura, altura: Math.round(largura * PROPORCAO_DA_FOLHA) });
  }, []);
  const prenderCaixa = useCallback((elemento: HTMLDivElement | null) => {
    caixa.current = elemento;
    if (elemento) medir();
  }, [medir]);
  useEffect(() => {
    if (!aberta) return;
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, [aberta, medir]);

  // Abriu de novo: folha limpa.
  useEffect(() => {
    if (aberta) { setTracos([]); canetaUsada.current = false; }
  }, [aberta]);

  const redesenhar = (lista: readonly Traco[]) => {
    const canvas = folha.current;
    const pincel = canvas?.getContext("2d");
    if (!canvas || !pincel || !tamanho.largura) return;
    const densidade = window.devicePixelRatio || 1;
    pincel.setTransform(1, 0, 0, 1, 0, 0);
    desenharTracos(pincel as unknown as Pincel, lista, canvas.width, canvas.height, densidade);
  };

  useEffect(() => { redesenhar(tracos); }, [tracos, tamanho]);

  const pontoDo = (evento: React.PointerEvent<HTMLCanvasElement>) => {
    const caixaDaFolha = evento.currentTarget.getBoundingClientRect();
    return { x: evento.clientX - caixaDaFolha.left, y: evento.clientY - caixaDaFolha.top, pressao: evento.pressure };
  };

  const comecar = (evento: React.PointerEvent<HTMLCanvasElement>) => {
    if (evento.pointerType === "pen") canetaUsada.current = true;
    if (!ponteiroDesenha(evento.pointerType, canetaUsada.current) || ponteiroAtivo.current !== null) return;
    evento.preventDefault();
    evento.currentTarget.setPointerCapture?.(evento.pointerId);
    ponteiroAtivo.current = evento.pointerId;
    tracoAtual.current = { cor, espessura, tipo: evento.pointerType, pontos: [pontoDo(evento)] };
    redesenhar([...tracos, tracoAtual.current]);
  };

  const mover = (evento: React.PointerEvent<HTMLCanvasElement>) => {
    if (ponteiroAtivo.current !== evento.pointerId || !tracoAtual.current) return;
    evento.preventDefault();
    // A caneta manda pontos entre um quadro e outro: todos entram, e a letra sai redonda.
    const eventos = evento.nativeEvent.getCoalescedEvents?.() ?? [];
    const caixaDaFolha = evento.currentTarget.getBoundingClientRect();
    if (eventos.length) {
      for (const e of eventos) tracoAtual.current.pontos.push({ x: e.clientX - caixaDaFolha.left, y: e.clientY - caixaDaFolha.top, pressao: e.pressure });
    } else {
      tracoAtual.current.pontos.push(pontoDo(evento));
    }
    redesenhar([...tracos, tracoAtual.current]);
  };

  const terminar = (evento: React.PointerEvent<HTMLCanvasElement>) => {
    if (ponteiroAtivo.current !== evento.pointerId) return;
    ponteiroAtivo.current = null;
    const pronto = tracoAtual.current;
    tracoAtual.current = null;
    if (pronto) setTracos(lista => [...lista, pronto]);
  };

  const guardar = async () => {
    if (!tracos.length || !tamanho.largura) return;
    const destino = tamanhoDaImagem(tamanho.largura, tamanho.altura, window.devicePixelRatio || 1, LADO_MAXIMO_DO_ANEXO);
    const canvas = document.createElement("canvas");
    canvas.width = destino.largura;
    canvas.height = destino.altura;
    const pincel = canvas.getContext("2d");
    if (!pincel) return;
    desenharTracos(pincel as unknown as Pincel, tracos, destino.largura, destino.altura, destino.escala);
    const dataUrl = canvas.toDataURL("image/png");
    canvas.width = 0; canvas.height = 0;
    setGuardando(true);
    try {
      await aoGuardar(dataUrl);
      aoFechar();
    } catch {
      // A falha já foi dita pela tela que chamou; a folha fica para tentar de novo.
    } finally {
      setGuardando(false);
    }
  };

  const densidade = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return <Dialog open={aberta} onOpenChange={aberto => { if (!aberto && !guardando) aoFechar(); }}>
    <DialogContent className="max-w-3xl border-amber-300/25 bg-[#211e1b] text-white">
      <DialogHeader>
        <DialogTitle className="text-amber-300">{t("meetings.attachments.drawTitle")}</DialogTitle>
        <DialogDescription className="text-sm text-white/70">{t("meetings.attachments.drawHint")}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t("meetings.attachments.drawTools")}>
        {CORES_DA_CANETA.map((valor, posicao) => <button key={valor} type="button" aria-pressed={cor === valor}
          aria-label={t("meetings.attachments.drawColor", { n: posicao + 1 })} onClick={() => setCor(valor)}
          className={`h-8 w-8 rounded-full border-2 ${cor === valor ? "border-amber-300" : "border-white/20"}`} style={{ backgroundColor: valor }}/>)}
        <span className="mx-1 h-6 w-px bg-white/15" aria-hidden="true"/>
        {ESPESSURAS_DA_CANETA.map((valor, posicao) => <button key={valor} type="button" aria-pressed={espessura === valor}
          aria-label={t("meetings.attachments.drawThickness", { n: posicao + 1 })} onClick={() => setEspessura(valor)}
          className={`grid h-8 w-8 place-items-center rounded-lg border ${espessura === valor ? "border-amber-300" : "border-white/15"}`}>
          <span className="rounded-full bg-white" style={{ width: valor + 2, height: valor + 2 }}/>
        </button>)}
        <span className="mx-1 h-6 w-px bg-white/15" aria-hidden="true"/>
        <button type="button" onClick={() => setTracos(lista => lista.slice(0, -1))} disabled={!tracos.length}
          className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/80 disabled:opacity-40"><Undo2 size={15}/>{t("meetings.attachments.drawUndo")}</button>
        <button type="button" onClick={() => setTracos([])} disabled={!tracos.length}
          className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/80 disabled:opacity-40"><Eraser size={15}/>{t("meetings.attachments.drawClear")}</button>
      </div>
      <div ref={prenderCaixa} className="w-full overflow-hidden rounded-lg">
        {tamanho.largura > 0 && <canvas ref={folha} role="img" aria-label={t("meetings.attachments.drawCanvas")}
          width={Math.round(tamanho.largura * densidade)} height={Math.round(tamanho.altura * densidade)}
          style={{ width: tamanho.largura, height: tamanho.altura, touchAction: "none" }}
          className="block cursor-crosshair bg-white select-none"
          onPointerDown={comecar} onPointerMove={mover} onPointerUp={terminar} onPointerCancel={terminar} onPointerLeave={terminar}/>}
      </div>
      <DialogFooter className="gap-2">
        <button type="button" onClick={aoFechar} disabled={guardando} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/80">{t("meetings.attachments.drawCancel")}</button>
        <button type="button" onClick={() => void guardar()} disabled={!tracos.length || guardando}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-300 px-4 py-2 text-sm font-bold text-[#1a120c] disabled:opacity-50">
          {guardando && <Loader2 size={15} className="animate-spin"/>}{t("meetings.attachments.drawSave")}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
