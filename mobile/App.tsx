// A casca da WRW para as lojas: abre o site de produção numa WebView e deixa o
// que é de fora (outros domínios, mailto:, tel:, WhatsApp) com o sistema. Os
// recursos nativos (gravação em segundo plano, Face ID, push) entram em PRs
// próprias; ver mobile/CLAUDE.md.
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  Keyboard,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { abaDoCaminho, barraAparece, scriptDasRotasDaBarra, scriptParaAbrir, type Aba } from './abas';
import { BarraDeAbas } from './BarraDeAbas';
import { lerMensagem, respostaDoMicrofone, scriptDaPonte } from './ponte';

const ETIQUETA_DA_GRAVACAO = 'wrw-gravacao';
// A ponte e a lista das telas da barra, que o Menu do site deixa de repetir.
const SCRIPT_DA_PONTE = scriptDaPonte(Platform.OS === 'android') + scriptDasRotasDaBarra();

/**
 * No Android, a WebView só entrega o microfone se o app tiver a permissão do
 * sistema. Pede aqui, antes de o site abrir o microfone; no iPhone, quem pede é
 * a própria WebView, com o texto do NSMicrophoneUsageDescription.
 */
async function liberarMicrofone(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const permissao = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permissao)) return true;
  const resposta = await PermissionsAndroid.request(permissao, {
    title: 'Microfone',
    message: 'A WRW usa o microfone para gravar as suas reuniões e ditados, só quando você toca em gravar.',
    buttonPositive: 'Permitir',
    buttonNegative: 'Agora não',
  });
  if (resposta === PermissionsAndroid.RESULTS.GRANTED) return true;
  if (resposta === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    Alert.alert(
      'Microfone bloqueado',
      'Para gravar, libere o microfone da WRW nas configurações do celular.',
      [
        { text: 'Agora não', style: 'cancel' },
        { text: 'Abrir configurações', onPress: () => void Linking.openSettings() },
      ],
    );
  }
  return false;
}

const ORIGEM = 'https://wrwglobal.org';
const HOSTS_DA_WRW = new Set(['wrwglobal.org', 'www.wrwglobal.org']);

function ehDaWrw(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && HOSTS_DA_WRW.has(hostname);
  } catch {
    return false;
  }
}

/** O caminho de uma URL da WRW ("/dashboard"); null para o resto. */
function caminhoDaWrw(url: string): string | null {
  if (!ehDaWrw(url)) return null;
  try {
    return new URL(url).pathname || '/';
  } catch {
    return null;
  }
}

function TelaDeErro({ aoTentarDeNovo }: { aoTentarDeNovo: () => void }) {
  return (
    <View style={estilos.erro}>
      <Text style={estilos.erroTitulo}>Sem conexão com a WRW</Text>
      <Text style={estilos.erroTexto}>Confira a internet do aparelho e tente de novo.</Text>
      <Pressable accessibilityRole="button" onPress={aoTentarDeNovo} style={estilos.botao}>
        <Text style={estilos.botaoTexto}>Tentar de novo</Text>
      </Pressable>
    </View>
  );
}

export default function App() {
  // WebView<object>, não WebView: o padrão da tipagem é WebView<undefined>, e
  // WebViewProps & undefined vira never, recusando todas as props.
  const webview = useRef<WebView<object>>(null);
  const [podeVoltar, setPodeVoltar] = useState(false);

  // Botão "voltar" do Android: volta no histórico do site antes de fechar o app.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const assinatura = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!podeVoltar) return false;
      webview.current?.goBack();
      return true;
    });
    return () => assinatura.remove();
  }, [podeVoltar]);

  // Gravação em andamento: a tela não apaga (no iPhone, a tela bloqueada para a
  // gravação). No iPhone, a WebView também para de gravar em segundo plano: avisa
  // ao começar e, se a pessoa saiu do app no meio, avisa ao voltar. A gravação
  // com a tela bloqueada é a gravação nativa, em PR própria (mobile/CLAUDE.md).
  const gravando = useRef(false);
  const saiuGravando = useRef(false);
  const avisouDoSegundoPlano = useRef(false);

  // Barra de abas (abas.ts): segue a página aberta e o idioma do site, que a
  // ponte avisa, e sai durante a gravação, com o teclado aberto e sem conexão.
  const [caminho, setCaminho] = useState<string | null>(null);
  const [idioma, setIdioma] = useState<{ lang: string; rtl: boolean }>({ lang: 'pt-BR', rtl: false });
  const [gravandoAgora, setGravandoAgora] = useState(false);
  const [semConexao, setSemConexao] = useState(false);
  const [tecladoAberto, setTecladoAberto] = useState(false);

  useEffect(() => {
    const abriu = Keyboard.addListener('keyboardDidShow', () => setTecladoAberto(true));
    const fechou = Keyboard.addListener('keyboardDidHide', () => setTecladoAberto(false));
    return () => {
      abriu.remove();
      fechou.remove();
    };
  }, []);

  const mostrarBarra = barraAparece({ caminho, gravando: gravandoAgora, semConexao, tecladoAberto });

  const aoTocarNaAba = useCallback((aba: Aba) => {
    setCaminho(aba.caminho);
    webview.current?.injectJavaScript(scriptParaAbrir(aba.caminho, ORIGEM));
  }, []);

  useEffect(() => {
    const assinatura = AppState.addEventListener('change', estado => {
      if (estado === 'background' && gravando.current && Platform.OS === 'ios') {
        saiuGravando.current = true;
      }
      if (estado === 'active' && saiuGravando.current) {
        saiuGravando.current = false;
        Alert.alert(
          'A gravação parou enquanto você estava fora',
          'No iPhone, a WRW ainda não grava em segundo plano. O trecho em que o app ficou fechado não foi gravado. Mantenha a WRW aberta até tocar em Parar.',
        );
      }
    });
    return () => assinatura.remove();
  }, []);

  useEffect(() => () => void deactivateKeepAwake(ETIQUETA_DA_GRAVACAO), []);

  const aoMudarGravacao = useCallback((ativo: boolean) => {
    if (ativo === gravando.current) return;
    gravando.current = ativo;
    setGravandoAgora(ativo);
    if (!ativo) {
      void deactivateKeepAwake(ETIQUETA_DA_GRAVACAO);
      return;
    }
    activateKeepAwakeAsync(ETIQUETA_DA_GRAVACAO).catch(() => undefined);
    if (Platform.OS === 'ios' && !avisouDoSegundoPlano.current) {
      avisouDoSegundoPlano.current = true;
      Alert.alert(
        'Mantenha a WRW aberta',
        'No iPhone, a gravação para se você sair do app ou bloquear a tela. A tela fica acesa sozinha até você tocar em Parar.',
      );
    }
  }, []);

  const aoReceberMensagem = useCallback(
    (evento: WebViewMessageEvent) => {
      const mensagem = lerMensagem(evento.nativeEvent.data);
      if (!mensagem) return;
      if (mensagem.tipo === 'log') {
        // Vai para o terminal do `npx expo start`: é por aqui que se vê o que
        // falhou no celular sem cabo nem inspetor.
        console.log(`[site ${mensagem.nivel}] ${mensagem.texto}`);
        return;
      }
      if (mensagem.tipo === 'gravando') {
        aoMudarGravacao(mensagem.ativo);
        return;
      }
      if (mensagem.tipo === 'rota') {
        if (typeof mensagem.caminho === 'string') setCaminho(mensagem.caminho);
        return;
      }
      if (mensagem.tipo === 'idioma') {
        if (typeof mensagem.lang === 'string') setIdioma({ lang: mensagem.lang, rtl: mensagem.dir === 'rtl' });
        return;
      }
      if (mensagem.tipo === 'microfone') {
        console.log(`[app ${Platform.OS}] pedido de microfone ${mensagem.id}`);
        liberarMicrofone()
          .catch(erro => {
            console.log(`[app ${Platform.OS}] falha ao pedir o microfone: ${String(erro)}`);
            return false;
          })
          .then(liberado => {
            console.log(`[app ${Platform.OS}] microfone ${mensagem.id}: ${liberado ? 'liberado' : 'negado'}`);
            webview.current?.injectJavaScript(respostaDoMicrofone(mensagem.id, liberado));
          });
      }
    },
    [aoMudarGravacao],
  );

  const aoNavegar = useCallback((estado: WebViewNavigation) => {
    setPodeVoltar(estado.canGoBack);
    const novo = caminhoDaWrw(estado.url);
    if (novo) setCaminho(novo);
  }, []);

  // Só páginas da WRW abrem dentro do app; o resto vai para o navegador ou o
  // app do sistema. about:blank e data: são os quadros internos da própria página.
  const aoPedirCarga = useCallback((pedido: ShouldStartLoadRequest) => {
    const { url } = pedido;
    if (ehDaWrw(url) || url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) {
      return true;
    }
    Linking.openURL(url).catch(() => undefined);
    return false;
  }, []);

  return (
    <SafeAreaProvider>
      {/* Com a barra, a margem de baixo do aparelho fica com ela, na cor dela. */}
      <SafeAreaView style={estilos.tela} edges={mostrarBarra ? ['top'] : ['top', 'bottom']}>
        <StatusBar style="light" />
        <WebView
          ref={webview}
          source={{ uri: ORIGEM }}
          style={estilos.tela}
          originWhitelist={['https://*', 'about:*', 'data:*', 'blob:*', 'mailto:*', 'tel:*']}
          onShouldStartLoadWithRequest={aoPedirCarga}
          onNavigationStateChange={aoNavegar}
          injectedJavaScriptBeforeContentLoaded={SCRIPT_DA_PONTE}
          // No Android, o script de antes do carregamento roda no onPageStarted e
          // pode cair na página velha (T41, 23/11: nenhum log chegou). O de
          // depois do carregamento garante a ponte; ela não se instala duas vezes.
          injectedJavaScript={SCRIPT_DA_PONTE}
          onMessage={aoReceberMensagem}
          onLoadEnd={evento => console.log(`[app ${Platform.OS}] página carregada: ${evento.nativeEvent.url}`)}
          onLoad={() => setSemConexao(false)}
          onError={() => setSemConexao(true)}
          webviewDebuggingEnabled={__DEV__}
          renderError={() => <TelaDeErro aoTentarDeNovo={() => webview.current?.reload()} />}
          applicationNameForUserAgent="WRWApp/1.0"
          sharedCookiesEnabled
          allowsBackForwardNavigationGestures
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
          pullToRefreshEnabled
          setSupportMultipleWindows={false}
          startInLoadingState
        />
        {mostrarBarra ? (
          <BarraDeAbas ativa={abaDoCaminho(caminho)} lang={idioma.lang} rtl={idioma.rtl} aoTocar={aoTocarNaAba} />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const estilos = StyleSheet.create({
  tela: { flex: 1, backgroundColor: '#000000' },
  erro: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#000000',
  },
  erroTitulo: { color: '#ffffff', fontSize: 20, fontWeight: '600', marginBottom: 8 },
  erroTexto: { color: '#cfc6c0', fontSize: 15, textAlign: 'center', marginBottom: 24 },
  botao: { backgroundColor: '#b87a5e', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 12 },
  botaoTexto: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
});
