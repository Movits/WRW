// A casca da WRW para as lojas: abre o site de produção numa WebView e deixa o
// que é de fora (outros domínios, mailto:, tel:, WhatsApp) com o sistema. Os
// recursos nativos (gravação em segundo plano, chaves de acesso na WebView,
// push) entram em PRs próprias; ver mobile/CLAUDE.md.
//
// A trava (mobile/regras/trava.ts): com ela ligada, o app pede o Face ID, a digital ou
// o bloqueio de tela ao abrir e ao voltar depois de 10 minutos em segundo
// plano. Desligada por padrão. Depois do login, um aviso pequeno oferece
// ligar; o Perfil do site, dentro do app, liga e desliga.
import { StatusBar } from 'expo-status-bar';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Linking, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import {
  avisoCabe,
  CHAVE_DA_TRAVA,
  CHAVE_DO_AVISO,
  lerPedidoDoSite,
  precisaTravarAoVoltar,
  scriptDoEstado,
} from './regras/trava';

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

function caminhoDe(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** Lê do cofre do celular; sem cofre (erro do sistema), conta como vazio. */
async function lerDoCofre(chave: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(chave);
  } catch {
    return null;
  }
}

async function gravarNoCofre(chave: string, valor: string | null) {
  try {
    if (valor === null) await SecureStore.deleteItemAsync(chave);
    else await SecureStore.setItemAsync(chave, valor);
  } catch {
    // Sem cofre: a escolha vale até fechar o app.
  }
}

/** O celular tem biometria ou bloqueio de tela cadastrado para o app pedir. */
async function temComoConferir(): Promise<boolean> {
  try {
    if (!(await LocalAuthentication.hasHardwareAsync())) return false;
    if (await LocalAuthentication.isEnrolledAsync()) return true;
    // Sem biometria cadastrada, o bloqueio de tela (PIN, senha, padrão) serve.
    return (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE;
  } catch {
    return false;
  }
}

/** Pede ao sistema o Face ID, a digital ou o bloqueio de tela. */
async function conferirAPessoa(motivo: string): Promise<boolean> {
  try {
    const resultado = await LocalAuthentication.authenticateAsync({
      promptMessage: motivo,
      cancelLabel: 'Cancelar',
      disableDeviceFallback: false,
    });
    return resultado.success;
  } catch {
    return false;
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

/** Cobre o app enquanto a trava pede a pessoa: nada do site aparece por baixo. */
function TelaDaTrava({ aoDesbloquear }: { aoDesbloquear: () => void }) {
  return (
    <View style={estilos.trava} accessibilityViewIsModal>
      <Text style={estilos.travaMarca}>WRW</Text>
      <Text style={estilos.travaTexto}>O app está protegido com o Face ID, a digital ou o bloqueio de tela deste celular.</Text>
      <Pressable accessibilityRole="button" onPress={aoDesbloquear} style={estilos.botao}>
        <Text style={estilos.botaoTexto}>Desbloquear</Text>
      </Pressable>
    </View>
  );
}

/** O aviso pequeno depois do login: ligar a trava, ou "Agora não". */
function AvisoDaTrava({ aoLigar, aoDispensar, ligando }: { aoLigar: () => void; aoDispensar: () => void; ligando: boolean }) {
  return (
    <View style={estilos.aviso} accessibilityRole="summary">
      <Text style={estilos.avisoTitulo}>Abrir o app com Face ID ou digital?</Text>
      <Text style={estilos.avisoTexto}>
        Fica mais fácil e mais seguro: ao abrir o app, ele pede o Face ID, a digital ou o bloqueio de tela deste celular. Dá para desligar no Perfil.
      </Text>
      <View style={estilos.avisoLinha}>
        <Text style={estilos.avisoRotulo}>Pedir ao abrir o app</Text>
        <Switch value={false} onValueChange={valor => { if (valor) aoLigar(); }} disabled={ligando} accessibilityLabel="Pedir Face ID ou digital ao abrir o app" />
      </View>
      <Pressable accessibilityRole="button" onPress={aoDispensar} disabled={ligando} style={estilos.avisoAgoraNao}>
        <Text style={estilos.avisoAgoraNaoTexto}>Agora não</Text>
      </Pressable>
    </View>
  );
}

export default function App() {
  // WebView<object>, não WebView: o padrão da tipagem é WebView<undefined>, e
  // WebViewProps & undefined vira never, recusando todas as props.
  const webview = useRef<WebView<object>>(null);
  const [podeVoltar, setPodeVoltar] = useState(false);
  const [caminho, setCaminho] = useState('');

  // ---- A trava ----
  const [carregada, setCarregada] = useState(false);
  const [ligada, setLigada] = useState(false);
  const [travado, setTravado] = useState(false);
  const [biometria, setBiometria] = useState(false);
  const [avisoRespondido, setAvisoRespondido] = useState(true);
  const [ligando, setLigando] = useState(false);
  const saiuEm = useRef<number | null>(null);
  const conferindo = useRef(false);

  const contarAoSite = useCallback((estado: { disponivel: boolean; ligada: boolean }) => {
    webview.current?.injectJavaScript(scriptDoEstado(estado));
  }, []);

  const desbloquear = useCallback(async () => {
    if (conferindo.current) return;
    conferindo.current = true;
    const ok = await conferirAPessoa('Abrir a WRW');
    conferindo.current = false;
    if (ok) setTravado(false);
  }, []);

  // Ao abrir: o que está guardado no cofre e se o celular tem como conferir.
  useEffect(() => {
    let ativo = true;
    (async () => {
      const [trava, aviso, tem] = await Promise.all([lerDoCofre(CHAVE_DA_TRAVA), lerDoCofre(CHAVE_DO_AVISO), temComoConferir()]);
      if (!ativo) return;
      const comTrava = trava === 'ligada' && tem;
      setBiometria(tem);
      setLigada(comTrava);
      setAvisoRespondido(aviso !== null);
      setTravado(comTrava);
      setCarregada(true);
      if (comTrava) void desbloquear();
    })();
    return () => { ativo = false; };
  }, [desbloquear]);

  // Ao voltar de segundo plano depois de 10 minutos, com a trava ligada, pede de novo.
  useEffect(() => {
    const assinatura = AppState.addEventListener('change', estado => {
      if (estado === 'background') {
        saiuEm.current = Date.now();
        return;
      }
      if (estado === 'active') {
        const voltar = precisaTravarAoVoltar(saiuEm.current, Date.now());
        saiuEm.current = null;
        if (ligada && voltar) {
          setTravado(true);
          void desbloquear();
        }
      }
    });
    return () => assinatura.remove();
  }, [ligada, desbloquear]);

  /** Liga a trava: confere a pessoa uma vez antes, para saber que funciona neste celular. */
  const ligar = useCallback(async () => {
    if (!biometria || ligando) return false;
    setLigando(true);
    const ok = await conferirAPessoa('Ligar o Face ID ou a digital na WRW');
    setLigando(false);
    if (!ok) return false;
    await Promise.all([gravarNoCofre(CHAVE_DA_TRAVA, 'ligada'), gravarNoCofre(CHAVE_DO_AVISO, 'respondido')]);
    setLigada(true);
    setAvisoRespondido(true);
    return true;
  }, [biometria, ligando]);

  const desligar = useCallback(async () => {
    await gravarNoCofre(CHAVE_DA_TRAVA, null);
    setLigada(false);
  }, []);

  const dispensarAviso = useCallback(async () => {
    await gravarNoCofre(CHAVE_DO_AVISO, 'respondido');
    setAvisoRespondido(true);
  }, []);

  // A conversa com o Perfil do site: só de página da WRW.
  const aoReceberMensagem = useCallback(async (evento: WebViewMessageEvent) => {
    if (!ehDaWrw(evento.nativeEvent.url)) return;
    const pedido = lerPedidoDoSite(evento.nativeEvent.data);
    if (!pedido) return;
    if (pedido.acao === 'ligar') {
      const ok = await ligar();
      contarAoSite({ disponivel: biometria, ligada: ok || ligada });
      return;
    }
    if (pedido.acao === 'desligar') {
      await desligar();
      contarAoSite({ disponivel: biometria, ligada: false });
      return;
    }
    contarAoSite({ disponivel: biometria, ligada });
  }, [biometria, ligada, ligar, desligar, contarAoSite]);

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

  const aoNavegar = useCallback((estado: WebViewNavigation) => {
    setPodeVoltar(estado.canGoBack);
    if (ehDaWrw(estado.url)) setCaminho(caminhoDe(estado.url));
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

  const mostrarAviso = carregada && !travado && avisoCabe({ caminho, biometria, ligada, avisoRespondido });

  return (
    <SafeAreaProvider>
      <SafeAreaView style={estilos.tela} edges={['top', 'bottom']}>
        <StatusBar style="light" />
        <WebView
          ref={webview}
          source={{ uri: ORIGEM }}
          style={estilos.tela}
          originWhitelist={['https://*', 'about:*', 'data:*', 'blob:*', 'mailto:*', 'tel:*']}
          onShouldStartLoadWithRequest={aoPedirCarga}
          onNavigationStateChange={aoNavegar}
          onMessage={evento => void aoReceberMensagem(evento)}
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
        {mostrarAviso && <AvisoDaTrava ligando={ligando} aoLigar={() => void ligar()} aoDispensar={() => void dispensarAviso()} />}
        {/* Antes de ler o cofre, uma tela preta (sem piscar o site de quem tem a
            trava ligada); com a trava pedindo, a tela da trava. */}
        {!carregada && <View style={estilos.trava} />}
        {carregada && travado && <TelaDaTrava aoDesbloquear={() => void desbloquear()} />}
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
  trava: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#000000',
  },
  travaMarca: { color: '#efcba8', fontSize: 40, fontWeight: '700', letterSpacing: 4, marginBottom: 16 },
  travaTexto: { color: '#cfc6c0', fontSize: 15, textAlign: 'center', marginBottom: 28, lineHeight: 21 },
  aviso: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 16,
    padding: 16,
    borderRadius: 16,
    backgroundColor: '#1b1714',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  avisoTitulo: { color: '#ffffff', fontSize: 16, fontWeight: '700', marginBottom: 6 },
  avisoTexto: { color: '#cfc6c0', fontSize: 14, lineHeight: 20, marginBottom: 12 },
  avisoLinha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  avisoRotulo: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  avisoAgoraNao: { alignSelf: 'flex-start', paddingVertical: 6 },
  avisoAgoraNaoTexto: { color: 'rgba(255,255,255,0.7)', fontSize: 14 },
});
