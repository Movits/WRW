// O lado JavaScript do módulo nativo chaves-na-webview (só Android): liga as
// chaves de acesso (passkeys) na WebView do app. No Expo Go o módulo não existe
// (é código nativo nosso, que só entra num build próprio do EAS): aí nada muda,
// e o site continua sem o login com chave dentro do app.
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type ModuloNativo = { ligar(tag: number): Promise<boolean> };

const modulo = Platform.OS === 'android' ? requireOptionalNativeModule<ModuloNativo>('ChavesNaWebView') : null;

/** Este build do app sabe ligar as chaves de acesso na WebView. */
export const chavesNaWebViewDisponiveis = modulo !== null;

/** Liga as chaves de acesso na WebView da tag dada. Devolve se ligou. */
export async function ligarChavesNaWebView(tag: number | null | undefined): Promise<boolean> {
  if (!modulo || tag === null || tag === undefined) return false;
  try {
    return await modulo.ligar(tag);
  } catch {
    return false;
  }
}
