import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, GripVertical, Loader2, Plus, Trash2 } from "lucide-react";
import {
  FILHOS_POR_FOLHA_MAX, FOLHAS_POR_RAMO_MAX, RAMOS_DO_MAPA_MAX, ROTULO_DO_MAPA_MAX, type MapaMental,
} from "@shared/mapa-mental";
import {
  acrescentarNo, apagarNo, conferirMapaEditado, moverNo, nosQueCabem, renomearNo, type CaminhoDoNo,
} from "@shared/mapa-mental-edicao";
import { mensagemDeErroParaTela, traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";

/**
 * O editor do mapa mental (H10b; HN-40 do app de referência da cliente), só
 * para a dona. O mapa vira um contorno, um campo por nó (até 60 caracteres):
 * - renomear: o próprio campo;
 * - reordenar: as setas (no celular e pelo teclado) ou arrastar pela alça;
 *   arrastar uma folha (ou um filho) para cima de outro ramo (ou outra folha)
 *   a leva para lá, no fim;
 * - acrescentar: "+ Ramo", "+ Ponto" no ramo e "+ Detalhe" na folha;
 * - apagar: a lixeira do nó, que leva junto o que sai dele.
 * Tudo numa cópia: "Cancelar" a descarta, "Salvar" confere com as mesmas
 * regras do servidor (conferirMapaEditado) e manda. O texto aparece no idioma
 * em que o mapa foi escrito, sem a tradução (H11): é ele que se guarda.
 */

type Props = {
  mapa: MapaMental;
  /** A direção do mapa (a do idioma em que foi escrito). */
  dir?: "ltr" | "rtl";
  lang?: string;
  salvando: boolean;
  erro: unknown;
  aoSalvar: (mapa: MapaMental) => void;
  aoCancelar: () => void;
};

const CAMPO = "min-w-0 flex-1 rounded-lg border border-white/15 bg-black/20 px-2.5 py-1.5 text-sm text-white placeholder:text-white/35 focus:border-amber-300/60 focus:outline-none";
const ICONE = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent";
const ACRESCENTAR = "inline-flex items-center gap-1 rounded-lg border border-dashed border-white/20 px-2.5 py-1 text-xs text-white/65 hover:bg-white/5 disabled:opacity-40";

const chave = (caminho: readonly number[]) => caminho.join(".");

export function EditorDoMapa({ mapa: inicial, dir, lang, salvando, erro, aoSalvar, aoCancelar }: Props) {
  const { t } = useTranslation();
  const [mapa, setMapa] = useState<MapaMental>(inicial);
  const [recusa, setRecusa] = useState<string | null>(null);
  const [arrastando, setArrastando] = useState<CaminhoDoNo | null>(null);
  const [focar, setFocar] = useState<string | null>(null);
  const campos = useRef(new Map<string, HTMLInputElement>());
  const cabe = nosQueCabem(mapa) > 0;

  // O nó acrescentado recebe o cursor.
  useEffect(() => {
    if (!focar) return;
    campos.current.get(focar)?.focus();
    setFocar(null);
  }, [focar, mapa]);

  const mudar = (novo: MapaMental) => { setMapa(novo); setRecusa(null); };
  const acrescentar = (pai: readonly [] | readonly [number] | readonly [number, number]) => {
    const { mapa: novo, caminho } = acrescentarNo(mapa, pai);
    if (!caminho) return;
    mudar(novo);
    setFocar(chave(caminho));
  };
  const salvar = () => {
    const conferido = conferirMapaEditado(mapa);
    if (!conferido.ok) { setRecusa(conferido.codigo); return; }
    aoSalvar(conferido.mapa);
  };

  // Arrastar e soltar (HTML5). Soltar num irmão põe o nó no lugar dele; soltar
  // num pai do nível de cima (o ramo, para uma folha; a folha, para um filho)
  // põe o nó no fim dele.
  const soltarEm = (alvo: CaminhoDoNo) => {
    if (!arrastando) return;
    if (alvo.length === arrastando.length) mudar(moverNo(mapa, arrastando, alvo));
    else if (alvo.length === arrastando.length - 1) {
      const fim = alvo.length === 1 ? mapa.ramos[alvo[0]]?.folhas.length ?? 0 : mapa.ramos[alvo[0]]?.folhas[alvo[1]!]?.filhos.length ?? 0;
      mudar(moverNo(mapa, arrastando, [...alvo, fim] as unknown as CaminhoDoNo));
    }
    setArrastando(null);
  };

  const linha = (caminho: CaminhoDoNo, valor: string, irmaos: number, rotuloAria: string, extra?: ReactNode) => {
    const indice = caminho[caminho.length - 1]!;
    const mover = (para: number) => mudar(moverNo(mapa, caminho, [...caminho.slice(0, -1), para] as unknown as CaminhoDoNo));
    const aoSoltar = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); soltarEm(caminho); };
    return <div className="flex items-center gap-1" data-caminho={chave(caminho)}
      onDragOver={e => { if (arrastando && (arrastando.length === caminho.length || arrastando.length === caminho.length + 1)) e.preventDefault(); }}
      onDrop={aoSoltar}>
      <span draggable onDragStart={e => { setArrastando(caminho); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", chave(caminho)); }}
        onDragEnd={() => setArrastando(null)}
        className="inline-flex h-8 w-6 shrink-0 cursor-grab items-center justify-center text-white/35" aria-hidden="true"><GripVertical size={15}/></span>
      <input ref={el => { if (el) campos.current.set(chave(caminho), el); else campos.current.delete(chave(caminho)); }}
        value={valor} maxLength={ROTULO_DO_MAPA_MAX} dir="auto" aria-label={rotuloAria}
        placeholder={t("meetings.mindMap.edit.placeholder")}
        onChange={e => mudar(renomearNo(mapa, caminho, e.target.value))} className={CAMPO}/>
      <button type="button" className={ICONE} disabled={indice === 0} onClick={() => mover(indice - 1)} aria-label={t("meetings.mindMap.edit.moveUp", { rotulo: valor })}><ArrowUp size={15}/></button>
      <button type="button" className={ICONE} disabled={indice >= irmaos - 1} onClick={() => mover(indice + 1)} aria-label={t("meetings.mindMap.edit.moveDown", { rotulo: valor })}><ArrowDown size={15}/></button>
      <button type="button" className={ICONE} onClick={() => mudar(apagarNo(mapa, caminho))} aria-label={t("meetings.mindMap.edit.remove", { rotulo: valor })}><Trash2 size={15}/></button>
      {extra}
    </div>;
  };

  const erroDoServidor = erro ? mensagemDeErroParaTela(erro, t) : null;
  return <div className="space-y-3" data-testid="editor-do-mapa">
    <p className="text-xs text-white/55">{t("meetings.mindMap.edit.help")}</p>
    <ol dir={dir} lang={lang} className="space-y-3">
      {mapa.ramos.map((ramo, r) => <li key={r} className="rounded-xl border border-amber-300/25 bg-amber-300/[0.05] p-2.5">
        {linha([r], ramo.rotulo, mapa.ramos.length, t("meetings.mindMap.edit.branchLabel", { n: r + 1 }))}
        <ul className="mt-2 space-y-2 border-s border-amber-300/20 ps-3 sm:ms-6">
          {ramo.folhas.map((folha, f) => <li key={f}>
            {linha([r, f], folha.rotulo, ramo.folhas.length, t("meetings.mindMap.edit.pointLabel", { n: f + 1, ramo: ramo.rotulo }))}
            <ul className="mt-1.5 space-y-1.5 border-s border-white/10 ps-3 sm:ms-6">
              {folha.filhos.map((filho, k) => <li key={k}>{linha([r, f, k], filho, folha.filhos.length, t("meetings.mindMap.edit.detailLabel", { n: k + 1, ponto: folha.rotulo }))}</li>)}
              <li><button type="button" className={ACRESCENTAR} disabled={!cabe || folha.filhos.length >= FILHOS_POR_FOLHA_MAX} onClick={() => acrescentar([r, f])}><Plus size={13}/>{t("meetings.mindMap.edit.addDetail")}</button></li>
            </ul>
          </li>)}
          <li><button type="button" className={ACRESCENTAR} disabled={!cabe || ramo.folhas.length >= FOLHAS_POR_RAMO_MAX} onClick={() => acrescentar([r])}><Plus size={13}/>{t("meetings.mindMap.edit.addPoint")}</button></li>
        </ul>
      </li>)}
    </ol>
    <button type="button" className={ACRESCENTAR} disabled={!cabe || mapa.ramos.length >= RAMOS_DO_MAPA_MAX} onClick={() => acrescentar([])}><Plus size={13}/>{t("meetings.mindMap.edit.addBranch")}</button>
    {!cabe && <p className="text-xs text-amber-200/80">{t("meetings.mindMap.edit.full")}</p>}
    {recusa && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{traduzirMensagemDoServidor(recusa, t)}</p>}
    {!recusa && erroDoServidor && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{erroDoServidor}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={salvar} disabled={salvando}
        className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
        {salvando && <Loader2 size={15} className="animate-spin"/>}{t("meetings.mindMap.edit.save")}
      </button>
      <button type="button" onClick={aoCancelar} disabled={salvando} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/75 hover:bg-white/5">{t("meetings.mindMap.edit.cancel")}</button>
    </div>
  </div>;
}
