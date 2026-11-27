// O push no celular (cartão "App: aviso no celular (push) de reunião pronta e
// de lembretes"). O app pede a permissão, lê o token do aparelho no Expo e o
// deixa na página; o site o manda ao servidor com a sessão da página
// (client/src/components/RegistroDoPush.tsx, server/push-no-celular.ts). O
// servidor manda o push pelo Expo; tocar nele abre a tela do aviso.
//
// - Só pede a permissão depois do login (na primeira tela logada), uma vez por
//   abertura do app. Recusou: não pergunta de novo, e o aviso fica no sino.
// - O texto do push é genérico, escrito pelo servidor no idioma da tela: nada
//   da reunião passa pelo Expo, pelo Google ou pela Apple.
// - No Android, o token só sai com o Firebase do time configurado
//   (google-services.json e a chave FCM V1 no EAS). Sem ele, a leitura do token
//   falha, vai para o log e o app segue como antes.
// - No Expo Go o push não funciona (desde o SDK 53): só no APK e nas lojas.
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type TokenDoPush = { token: string; plataforma: 'ios' | 'android' };

/** O canal do Android para os avisos (o Android 13+ só pergunta depois de existir um canal). */
const CANAL = 'avisos';

/** Com o app aberto, o push também aparece no topo da tela. */
export function configurarAvisosNoApp() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * Pede a permissão e lê o token do Expo. null quando a pessoa recusou, ou
 * quando o token não sai (Expo Go, Android sem o Firebase, sem projectId).
 */
export async function obterTokenDoPush(): Promise<TokenDoPush | null> {
  const plataforma = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : null;
  if (!plataforma) return null;
  try {
    if (plataforma === 'android') {
      await Notifications.setNotificationChannelAsync(CANAL, {
        name: 'Avisos',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const atual = await Notifications.getPermissionsAsync();
    let liberado = atual.granted;
    if (!liberado && atual.canAskAgain) liberado = (await Notifications.requestPermissionsAsync()).granted;
    if (!liberado) return null;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      console.log('[app push] sem o projectId do EAS no app.json: o token não sai');
      return null;
    }
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: data, plataforma };
  } catch (erro) {
    console.log(`[app push] o token do aparelho não saiu: ${String(erro)}`);
    return null;
  }
}

/** O script que deixa o token na página e avisa o site (client/src/lib/push-do-app.ts). */
export function scriptDoTokenDoPush(dados: TokenDoPush): string {
  return `
(function () {
  try {
    window.__wrwTokenDoPush = ${JSON.stringify(dados)};
    window.dispatchEvent(new Event('wrw:token-do-push'));
  } catch (e) {}
})();
true;
`;
}

/**
 * O endereço que o push manda abrir: só um caminho do próprio site ("/meetings/12",
 * "/gravar?agendada=9"). Endereço completo ou de fora é ignorado.
 */
export function enderecoDoAviso(resposta: Notifications.NotificationResponse | null | undefined): string | null {
  if (!resposta || resposta.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
  const url = resposta.notification.request.content.data?.url;
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
  return url.slice(0, 500);
}
