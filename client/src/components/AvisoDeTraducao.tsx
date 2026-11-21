import type { RefObject } from "react";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "@/i18n";

/**
 * O aviso de que a transcrição na tela é uma tradução da IA (T25, 21/11/2026).
 * O "Idioma de destino" da aba Transcrição começa no idioma do site, e a
 * reunião em outro idioma abria já traduzida, em texto corrido e sem nada que
 * dissesse que era tradução: numa reunião marcada "Inglês", lida com o site em
 * português, o inglês "sumia". "Ver original" põe o seletor no idioma da
 * reunião, que volta às falas com o falante e o horário. Usado no detalhe da
 * dona (Meetings.tsx) e no link aberto (ReuniaoAberta.tsx).
 *
 * O botão some junto com o aviso, e o foco cairia no <body>: quem usa teclado
 * ou leitor de tela voltaria ao começo da página. `focoDepois` é quem recebe o
 * foco depois do clique; nas duas telas, o seletor do idioma de destino, que
 * passa a mostrar o original.
 */

// O nome do idioma no idioma da tela ("inglês", "English"), só a base, como na
// voz do resumo (OuvirOResumo). Sem o Intl.DisplayNames, o nome do seletor.
function nomeDoIdiomaNaTela(codigo: string, idiomaDaTela: string) {
  const base = codigo.split("-")[0];
  try {
    const nome = new Intl.DisplayNames([idiomaDaTela], { type: "language" }).of(base);
    if (nome && nome !== base) return nome;
  } catch {
    // Cai no nome do seletor, logo abaixo.
  }
  return LANGUAGES.find(idioma => idioma.code === codigo)?.label ?? codigo;
}

export function AvisoDeTraducao({ idioma, aoVerOriginal, focoDepois }: { idioma: string; aoVerOriginal: () => void; focoDepois: RefObject<HTMLElement | null> }) {
  const { t, i18n } = useTranslation();
  // O ícone e o texto andam juntos: com o texto longo (site em alemão ou
  // russo, destino português, tela de 375 px), o ícone ia sozinho para a
  // primeira linha. A caixa dele tem a altura de uma linha do texto, e o ícone
  // fica no meio da primeira linha. O "Ver original" quebra para a linha de
  // baixo quando não cabe, rente à margem, como antes.
  return <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-amber-100/80">
    <span className="flex min-w-0 items-start gap-2">
      <span className="flex h-5 shrink-0 items-center"><Languages size={15} aria-hidden="true"/></span>
      <span>{t("meetings.autoTranslationNotice", { idioma: nomeDoIdiomaNaTela(idioma, i18n.resolvedLanguage ?? i18n.language) })}</span>
    </span>
    <button type="button" onClick={() => { aoVerOriginal(); focoDepois.current?.focus(); }} className="font-semibold text-amber-300 underline underline-offset-2 hover:text-amber-200">{t("meetings.seeOriginal")}</button>
  </p>;
}
