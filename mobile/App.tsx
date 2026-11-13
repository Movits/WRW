// A casca da WRW para as lojas: abre o site de produção numa WebView e deixa o
// que é de fora (outros domínios, mailto:, tel:, WhatsApp) com o sistema. Os
// recursos nativos (gravação em segundo plano, Face ID, push) entram em PRs
// próprias; ver mobile/CLAUDE.md.
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

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

  const aoNavegar = useCallback((estado: WebViewNavigation) => {
    setPodeVoltar(estado.canGoBack);
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
      <SafeAreaView style={estilos.tela} edges={['top', 'bottom']}>
        <StatusBar style="light" />
        <WebView
          ref={webview}
          source={{ uri: ORIGEM }}
          style={estilos.tela}
          originWhitelist={['https://*', 'about:*', 'data:*', 'blob:*', 'mailto:*', 'tel:*']}
          onShouldStartLoadWithRequest={aoPedirCarga}
          onNavigationStateChange={aoNavegar}
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
