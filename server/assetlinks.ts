/**
 * O Digital Asset Links do site: https://wrwglobal.org/.well-known/assetlinks.json
 * diz ao Android que o app org.wrwglobal.app é da WRW. Sem ele, o Android não
 * libera as chaves de acesso (passkeys) do site dentro da WebView do app (M1:
 * o módulo mobile/modules/chaves-na-webview liga a WebAuthn no modo "para o
 * app", e o sistema confere esta associação antes de usar a chave).
 *
 * Rota própria, e não um arquivo em client/public: o express.static ignora
 * pastas que começam com ponto, e o pedido cairia no index.html (200 com HTML),
 * que o Android rejeita.
 *
 * As impressões digitais são públicas (são do certificado que assina o app,
 * não da chave privada). Cada assinatura nova entra aqui por PR: a do APK de
 * teste do EAS agora; a da Play App Signing quando a conta do Google Play
 * existir (Play Console > Proteção do Play > Assinatura de apps).
 */
import type { Express } from "express";

export const CAMINHO_DO_ASSETLINKS = "/.well-known/assetlinks.json";

/** O pacote do app das lojas (mobile/app.json, android.package). */
export const PACOTE_DO_APP = "org.wrwglobal.app";

/** SHA-256 dos certificados que assinam o app, no formato que o Android pede. */
export const IMPRESSOES_DO_APP: readonly string[] = [
  // Assinatura padrão do projeto no EAS (@nicolas240767/wrw), criada em
  // 17/11/2026 e usada pelos builds de teste (perfil preview).
  "01:50:ED:B7:34:01:43:06:B3:C8:A6:E3:BB:C7:E2:E3:FE:A7:E9:61:DD:78:74:49:E8:88:D3:A5:84:F3:A8:AB",
];

/**
 * As relações: get_login_creds deixa o app usar as credenciais do site (as
 * chaves de acesso); handle_all_urls é a associação de links que a
 * documentação do Credential Manager pede junto. O app não declara abrir links
 * do site por conta própria, então esta segunda não muda nada sozinha.
 */
export function declaracoesDoAssetLinks() {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
      target: {
        namespace: "android_app",
        package_name: PACOTE_DO_APP,
        sha256_cert_fingerprints: [...IMPRESSOES_DO_APP],
      },
    },
  ];
}

/** Registra a rota antes do Vite e do estático, que responderiam o index.html no lugar. */
export function registrarAssetLinks(app: Express) {
  const corpo = JSON.stringify(declaracoesDoAssetLinks());
  app.get(CAMINHO_DO_ASSETLINKS, (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.type("application/json").send(corpo);
  });
}
