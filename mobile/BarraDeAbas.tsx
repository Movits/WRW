// A barra de abas de baixo, desenhada pelo app (não pelo site). Cada aba leva a
// WebView a uma tela do site; ver abas.ts. Os ícones são os mesmos do menu do
// site (lucide), e Reuniões é o botão redondo do centro.
import { Briefcase, CalendarDays, House, Mic, Users, type LucideIcon } from 'lucide-react-native';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ABAS, nomeDaAba, type Aba, type IdDaAba } from './abas';

// As cores do cabeçalho escuro do site (client/src/components/AppHeader.tsx e o
// tema escuro de client/src/index.css). O botão do centro usa as do "Gravar" do
// Início do site: fundo cobre e ícone escuro.
const CORES = {
  fundo: '#151312',
  borda: '#3B342D',
  texto: '#A0968C',
  ativa: '#C98F70',
  centro: '#C98F70',
  centroAtivo: '#EFCBA8',
  iconeDoCentro: '#1A120C',
};

const ICONES: Record<IdDaAba, LucideIcon> = {
  inicio: House,
  rede: Users,
  reunioes: Mic,
  oportunidades: Briefcase,
  agenda: CalendarDays,
};

type Props = {
  ativa: IdDaAba | null;
  lang: string | null;
  /** O site está em árabe: as abas vão da direita para a esquerda. */
  rtl: boolean;
  aoTocar: (aba: Aba) => void;
};

export function BarraDeAbas({ ativa, lang, rtl, aoTocar }: Props) {
  const margens = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={[estilos.barra, { paddingBottom: Math.max(margens.bottom, 6), flexDirection: rtl ? 'row-reverse' : 'row' }]}
    >
      {ABAS.map(aba => {
        const selecionada = aba.id === ativa;
        const nome = nomeDaAba(aba.id, lang);
        const Icone = ICONES[aba.id];
        return (
          <Pressable
            key={aba.id}
            accessibilityRole="tab"
            accessibilityLabel={nome}
            accessibilityState={{ selected: selecionada }}
            onPress={() => aoTocar(aba)}
            style={({ pressed }) => [estilos.aba, pressed && estilos.abaApertada]}
          >
            {aba.destaque ? (
              <View style={[estilos.centro, selecionada && estilos.centroAtivo]}>
                <Icone color={CORES.iconeDoCentro} size={26} strokeWidth={2.2} />
              </View>
            ) : (
              <Icone color={selecionada ? CORES.ativa : CORES.texto} size={24} strokeWidth={selecionada ? 2.3 : 1.8} />
            )}
            <Text
              style={[estilos.nome, selecionada && estilos.nomeAtivo]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            >
              {nome}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const TAMANHO_DO_CENTRO = 58;

const estilos = StyleSheet.create({
  barra: {
    backgroundColor: CORES.fundo,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: CORES.borda,
    paddingTop: 8,
    paddingHorizontal: 4,
    alignItems: 'flex-end',
    overflow: 'visible',
  },
  aba: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', minHeight: 48, paddingHorizontal: 2, overflow: 'visible' },
  abaApertada: { opacity: 0.6 },
  // O botão do centro sobe acima da barra, com um anel na cor da barra para
  // separar do site atrás dele.
  centro: {
    width: TAMANHO_DO_CENTRO,
    height: TAMANHO_DO_CENTRO,
    borderRadius: TAMANHO_DO_CENTRO / 2,
    marginTop: -TAMANHO_DO_CENTRO / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CORES.centro,
    borderWidth: 4,
    borderColor: CORES.fundo,
    ...Platform.select({
      ios: { shadowColor: '#000000', shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
      android: { elevation: 6 },
    }),
  },
  centroAtivo: { backgroundColor: CORES.centroAtivo },
  nome: { color: CORES.texto, fontSize: 11, marginTop: 4, textAlign: 'center' },
  nomeAtivo: { color: CORES.ativa, fontWeight: '700' },
});
