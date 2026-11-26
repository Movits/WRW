import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { proximaVozLivre, TEXTO_DO_TRECHO_MAX } from "@shared/editar-transcricao";

/**
 * O formulário de um trecho da transcrição (H18), à parte do resto da edição
 * (EditarTranscricao.tsx): a lista por falante (TranscricaoPorFalante.tsx), que
 * a página do link aberto também usa, o abre sem carregar as mutações da dona.
 * Os estilos dos campos e botões valem para os dois arquivos.
 */
// 16 px no celular: com menos, o iPhone aproxima a página ao tocar no campo.
export const CAMPO = "mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-base text-white outline-none placeholder:text-white/35 focus:border-amber-300 sm:text-sm";
export const ROTULO = "block text-xs font-semibold text-white/60";
export const BOTAO_PRINCIPAL = "inline-flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-bold text-[#1a120c] disabled:opacity-50";
export const BOTAO_SECUNDARIO = "inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:text-white disabled:opacity-50";

/** As vozes que a lista oferece: as da transcrição, em ordem, mais a do trecho. */
function vozesEmOrdem(vozes: readonly string[], doTrecho: string): string[] {
  const todas = Array.from(new Set([...vozes, doTrecho].filter(voz => /^F[1-9][0-9]?$/.test(voz))));
  return todas.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/**
 * O formulário de um trecho: o texto e a voz. "Nova voz" é o primeiro rótulo
 * livre (a pessoa que a IA juntou a outra voz). Salva só o que mudou; o trecho
 * não fica vazio. Esc cancela, como no nome da voz.
 *
 * Com o campo vazio, o "Salvar" para antes do servidor, e a frase da recusa
 * dele (errorEmpty, com o jeito de tirar uma fala inteira) aparece sob o campo:
 * só o botão cinza não dizia por quê.
 */
export function FormularioDoTrecho({ texto, falante, vozes, rotulo, aoSalvar, aoFechar }: {
  texto: string;
  falante: string;
  vozes: readonly string[];
  rotulo: (falante: string) => string;
  aoSalvar: (mudancas: { texto?: string; falante?: string }) => Promise<boolean>;
  aoFechar: () => void;
}) {
  const { t } = useTranslation();
  const [novoTexto, setNovoTexto] = useState(texto);
  const [novaVoz, setNovaVoz] = useState(falante);
  const [salvando, setSalvando] = useState(false);
  const idDoAvisoDeVazio = useId();
  const vazio = !novoTexto.trim();
  const opcoes = vozesEmOrdem(vozes, falante);
  const livre = proximaVozLivre(opcoes);

  async function salvar(evento: FormEvent) {
    evento.preventDefault();
    const aparado = novoTexto.trim();
    if (!aparado || salvando) return;
    const mudancas = { ...(aparado !== texto ? { texto: aparado } : {}), ...(novaVoz !== falante ? { falante: novaVoz } : {}) };
    if (!Object.keys(mudancas).length) return aoFechar();
    setSalvando(true);
    try {
      if (await aoSalvar(mudancas)) aoFechar();
    } finally {
      setSalvando(false);
    }
  }

  return <form onSubmit={salvar} aria-label={t("meetings.editTranscript.editSegment")}
    onKeyDown={evento => { if (evento.key === "Escape" && !salvando) aoFechar(); }}
    className="mt-2 space-y-3 rounded-xl border border-amber-300/30 bg-black/20 p-3">
    <label className={ROTULO}>{t("meetings.editTranscript.segmentText")}
      <textarea autoFocus required value={novoTexto} onChange={evento => setNovoTexto(evento.target.value)} maxLength={TEXTO_DO_TRECHO_MAX}
        aria-invalid={vazio || undefined} aria-describedby={vazio ? idDoAvisoDeVazio : undefined}
        rows={Math.min(10, Math.max(3, Math.ceil(texto.length / 70)))} dir="auto" className={`${CAMPO} resize-y leading-6`}/>
    </label>
    {vazio && <p id={idDoAvisoDeVazio} role="status" className="text-xs text-amber-200/90">{t("meetings.editTranscript.errorEmpty")}</p>}
    {falante && <label className={ROTULO}>{t("meetings.editTranscript.segmentVoice")}
      <select value={novaVoz} onChange={evento => setNovaVoz(evento.target.value)} className={`${CAMPO} bg-[#211e1b]`}>
        {opcoes.map(voz => <option key={voz} value={voz} className="bg-white text-[#322C26]">{rotulo(voz)}</option>)}
        {livre && <option value={livre} className="bg-white text-[#322C26]">{t("meetings.editTranscript.newVoice", { nome: rotulo(livre) })}</option>}
      </select>
    </label>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={salvando || vazio} className={BOTAO_PRINCIPAL}>
        {salvando ? <Loader2 size={14} className="animate-spin" aria-hidden/> : <Check size={14} aria-hidden/>} {t("meetings.editTranscript.save")}
      </button>
      <button type="button" onClick={aoFechar} disabled={salvando} className={BOTAO_SECUNDARIO}>{t("meetings.editTranscript.cancel")}</button>
    </div>
  </form>;
}
