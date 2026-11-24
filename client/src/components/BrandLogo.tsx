// Identidade visual oficial: WRW — Women Rocking the World (decisão do Roberto em
// 15/09, logo da Cris). As artes de /brand foram geradas dos originais guardados em
// docs/identidade-visual/wrw/. O nome é marca e não se traduz, por isso não há mais
// arte nem alt por idioma: os 10 idiomas usam as mesmas peças.
const ARTES = {
  monograma: "/brand/monograma-branco.png",
  wordmark: "/brand/wordmark-branco.png",
  lockup: "/brand/lockup-branco.png",
  destaque: "/brand/lockup-cor.png",
  selo: "/brand/selo.png",
} as const;

// O nome visível é MarquesaMatch desde 23/11/2026 (decisão da cliente). A logo nova
// ainda não chegou: as artes acima seguem as da WRW até a troca, e o alt já diz o nome.
const ALT = "MarquesaMatch";

type Variante = keyof typeof ARTES;

export function BrandLogo({ variante, className }: {
  /**
   * monograma: letras WRW brancas num quadrado; wordmark: só as letras WRW, brancas,
   * largura livre (headers); lockup: completo branco (com nome e lema); destaque:
   * completo em dourado rosé, peça de login/hero; selo: circular p/ avatares.
   */
  variante: Variante;
  className?: string;
}) {
  return <img src={ARTES[variante]} alt={ALT} className={className} />;
}

/** Marca compacta dos headers: a arte do wordmark WRW, na altura do antigo monograma. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center cursor-pointer ${className ?? ""}`}>
      <BrandLogo variante="wordmark" className="h-7 w-auto" />
    </span>
  );
}
