package org.wrwglobal.chavesnawebview

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Deixa a página da WRW usar as chaves de acesso (passkeys) do aparelho dentro
 * da WebView do app (M1). A WebView do react-native-webview nasce com a
 * WebAuthn desligada; aqui ela é ligada no modo "para o app"
 * (WEB_AUTHENTICATION_SUPPORT_FOR_APP), em que o Android só libera a chave se o
 * site estiver associado a este app pelo Digital Asset Links
 * (https://wrwglobal.org/.well-known/assetlinks.json, com o pacote
 * org.wrwglobal.app e a impressão digital da assinatura).
 *
 * Fica num módulo nosso, e não num remendo do react-native-webview: a WebView
 * é achada pela tag que o React Native dá à view, e só a configuração dela
 * muda. Sem suporte na WebView instalada no aparelho, devolve false e nada muda.
 */
class ChavesNaWebViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChavesNaWebView")

    AsyncFunction("ligar") { tag: Int ->
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
        return@AsyncFunction false
      }
      val raiz = appContext.findView<View>(tag) ?: return@AsyncFunction false
      val webView = acharWebView(raiz) ?: return@AsyncFunction false
      WebSettingsCompat.setWebAuthenticationSupport(
        webView.settings,
        WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP,
      )
      true
    }.runOnQueue(Queues.MAIN)
  }

  /** A WebView dentro da view do react-native-webview (um FrameLayout que a embrulha). */
  private fun acharWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (indice in 0 until view.childCount) {
        acharWebView(view.getChildAt(indice))?.let { return it }
      }
    }
    return null
  }
}
