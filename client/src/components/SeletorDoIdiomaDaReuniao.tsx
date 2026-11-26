import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { LANGUAGES } from "@/i18n";
import { ehIdiomaDaTela, nomeDoIdiomaNaTela, outrosIdiomasFalados } from "@/lib/idiomas-na-tela";
import {
  escolhaDoIdioma, IDIOMA_AUTOMATICO, IDIOMA_DA_REUNIAO_PADRAO, idiomaFalado, idiomasDasFalas, nomeDoIdiomaEm, type EscolhaDoIdioma,
} from "@shared/idioma-da-reuniao";

/**
 * O "Idioma da reunião" (G16): "Detectar sozinho" no topo, os 10 idiomas da
 * tela (com a bandeira e o nome no próprio idioma, como no seletor do site) e
 * os outros 99 que a IA transcreve, pelo nome no idioma de quem lê. Serve ao
 * gravador (a gravação, o arquivo e o documento) e ao vídeo do YouTube.
 *
 * O padrão continua o idioma da tela, como antes do G16: "Detectar sozinho" é
 * uma escolha da dona (decisão vetável, anotada na PR do pacote).
 */
export function SeletorDoIdiomaDaReuniao({ id, valor, aoMudar, desligado, className }: {
  id?: string;
  valor: EscolhaDoIdioma;
  aoMudar: (escolha: EscolhaDoIdioma) => void;
  desligado?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const tela = i18n.resolvedLanguage ?? i18n.language;
  const outros = useMemo(() => outrosIdiomasFalados(tela), [tela]);
  return <select id={id} disabled={desligado} value={valor} onChange={evento => aoMudar(escolhaDoIdioma(evento.target.value) ?? IDIOMA_DA_REUNIAO_PADRAO)} className={className}>
    <option className="bg-white text-[#322C26]" value={IDIOMA_AUTOMATICO}>{t("meetings.meetingLanguageAuto")}</option>
    <optgroup className="bg-white text-[#322C26]" label={t("meetings.meetingLanguageScreenGroup")}>
      {LANGUAGES.map(idioma => <option className="bg-white text-[#322C26]" key={idioma.code} value={idioma.code}>{idioma.flag} {idioma.label}</option>)}
    </optgroup>
    <optgroup className="bg-white text-[#322C26]" label={t("meetings.meetingLanguageOtherGroup")}>
      {outros.map(idioma => <option className="bg-white text-[#322C26]" key={idioma.codigo} value={idioma.codigo}>{idioma.nome}</option>)}
    </optgroup>
  </select>;
}

/** A dica do campo: a de sempre, ou a do "Detectar sozinho". */
export function DicaDoIdiomaDaReuniao({ valor, className }: { valor: EscolhaDoIdioma; className?: string }) {
  const { t } = useTranslation();
  return <p className={className}>{valor === IDIOMA_AUTOMATICO ? t("meetings.meetingLanguageAutoHint") : t("meetings.meetingLanguageHint")}</p>;
}

/**
 * A opção do idioma original na lista de tradução, quando ele não é um dos 10
 * da tela (G16): sem ela, a reunião em italiano aberta com a tela em
 * português não teria como voltar ao original. Nos 10, a lista já tem o
 * idioma, marcado "(original)", e esta opção não aparece.
 */
export function OpcaoDoIdiomaOriginal({ idioma }: { idioma: string | null | undefined }) {
  const { t, i18n } = useTranslation();
  if (!idioma || ehIdiomaDaTela(idioma)) return null;
  return <option className="bg-white text-[#322C26]" value={idioma}>{nomeDoIdiomaNaTela(idioma, i18n.resolvedLanguage ?? i18n.language)} {t("meetings.originalLanguageSuffix")}</option>;
}

// Abaixo disso, o idioma é uma palavra solta ("ok", um nome estrangeiro), e não
// uma parte da conversa.
const FRACAO_MINIMA = 0.05;
const IDIOMAS_NA_FRASE = 4;

/**
 * O que a IA reconheceu na reunião com "Detectar sozinho" (G16), no detalhe da
 * dona: o idioma, ou os idiomas com a fração de cada um quando a conversa mudou
 * de idioma, e qual deles o resumo usa (o que mais aparece, que é o da
 * transcrição). Sem as falas (o envio único, o documento), só o idioma da
 * transcrição. Nada aparece na reunião com o idioma escolhido.
 */
export function IdiomasDetectados({ escolha, idiomaDaTranscricao, segmentos }: {
  escolha: string | null | undefined;
  idiomaDaTranscricao: string | null | undefined;
  segmentos: unknown;
}) {
  const { t, i18n } = useTranslation();
  if (escolhaDoIdioma(escolha) !== IDIOMA_AUTOMATICO) return null;
  const tela = i18n.resolvedLanguage ?? i18n.language;
  // No meio da frase, o nome como o idioma de quem lê o escreve ("inglês" em
  // português, "Englisch" em alemão), sem a maiúscula das listas.
  const nome = (codigo: string) => nomeDoIdiomaEm(codigo, tela);
  const partes = idiomasDasFalas(Array.isArray(segmentos) ? segmentos : [])
    .filter(parte => parte.fracao >= FRACAO_MINIMA).slice(0, IDIOMAS_NA_FRASE);
  const principal = idiomaFalado(idiomaDaTranscricao) ?? partes[0]?.idioma ?? null;
  if (!principal) return null;
  let frase: string;
  if (partes.length < 2) frase = t("meetings.detectedLanguage", { idioma: nome(principal) });
  else {
    const porcento = (fracao: number) => {
      try {
        return new Intl.NumberFormat(tela, { style: "percent", maximumFractionDigits: 0 }).format(fracao);
      } catch {
        return `${Math.round(fracao * 100)}%`;
      }
    };
    frase = t("meetings.detectedLanguages", {
      idiomas: partes.map(parte => `${nome(parte.idioma)} (${porcento(parte.fracao)})`).join(", "),
      principal: nome(principal),
    });
  }
  return <p role="note" className="mb-4 inline-flex items-start gap-2 text-xs text-white/60"><Languages size={14} className="mt-0.5 shrink-0 text-amber-300" aria-hidden/>{frase}</p>;
}
