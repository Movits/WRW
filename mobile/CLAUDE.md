# mobile/

App da WRW para a App Store e a Play Store, em Expo (SDK 58). É uma casca: abre
`https://wrwglobal.org` numa WebView. O que é de outro domínio (mailto:, tel:, WhatsApp,
links externos) abre fora do app. Decisão de 10/11/2026, aprovada pela Dra. Glenda em
reunião com o Roberto: casca Expo com recursos nativos, em vez de PWA ou de reescrita.

Pacote separado do resto do repositório. Usa **npm** (`package-lock.json`), não o pnpm da
raiz. O `pnpm check`, o `pnpm test` e o CI da raiz não olham esta pasta.

## Comandos (dentro de `mobile/`)

```bash
npm install
npx expo install <pacote>   # sempre assim, nunca npm install <pacote>: escolhe a versão do SDK
npx expo start              # QR para o Expo Go (só a casca; módulo nativo novo pede development build)
npx tsc --noEmit            # tipos
npx expo-doctor             # dependências e config
npx eas-cli@latest build --profile preview --platform android   # APK para instalar direto
npx eas-cli@latest build --profile production --platform all    # arquivos das lojas
npx eas-cli@latest submit --platform ios|android                # envia para as lojas
```

## Regras

- **Expo muda a cada SDK.** Antes de usar uma API do Expo ou do EAS, leia a documentação
  da versão em uso (`https://docs.expo.dev/versions/v58.0.0/`). Não escreva de memória.
- `ios/` e `android/` são gerados pelo EAS e não entram no repositório. Configuração
  nativa vai no `app.json` ou num config plugin.
- **O Expo Go não publica.** Ele serve para testar a casca. A gravação em segundo plano
  e o Face ID pedem um development build (`eas build --profile development`).
- **`bundleIdentifier` e `package` (`org.wrwglobal.app`) ficam fixos depois do primeiro
  envio às lojas.** Para trocar, é preciso publicar um app novo.
- **A Apple recusa site embrulhado** (regra 4.2). O que segura o app na revisão são os
  recursos nativos: gravação com a tela bloqueada, Face ID e push. Cada um entra numa PR
  própria. A gravação nativa segue o desenho do gravador
  (`docs/arquitetura/gravador-de-reunioes.md`): mesmo envio em partes, mesmas regras de
  consentimento.
- O texto de permissão do microfone (`NSMicrophoneUsageDescription`) aparece na revisão
  da Apple. Precisa dizer para que o microfone serve.
- O user agent termina em `WRWApp/1.1`, para o site saber que está dentro do app. O build
  que liga as chaves de acesso na WebView acrescenta `WRWChaves/1`; o site só mostra o
  login com chave dentro do app quando vê esse sinal.
- **Chaves de acesso dentro do app (M1, só Android por enquanto):** o módulo nativo nosso
  `modules/chaves-na-webview` liga a WebAuthn na WebView do react-native-webview
  (`WebSettingsCompat.setWebAuthenticationSupport`, modo `FOR_APP`), sem remendar a
  biblioteca. O Android só libera a chave com o site associado ao app pelo
  `https://wrwglobal.org/.well-known/assetlinks.json` (pacote `org.wrwglobal.app` e o
  SHA-256 da assinatura, que sai de `eas credentials`). Na WebView não há sugestão
  automática no campo (`mediation: "conditional"`): o login com chave é pelo botão. O
  módulo não existe no Expo Go; para testar, o APK do perfil `preview`, instalado por
  `adb` (o Android no Brasil bloqueia instalar fora da loja sem desenvolvedor
  verificado). No iPhone falta o Associated Domains, que depende do Team ID da Apple.
- **A trava do app** (`regras/trava.ts` e `App.tsx`): com ela ligada, o app pede o Face ID, a
  digital ou o bloqueio de tela ao abrir e ao voltar depois de 10 minutos em segundo plano.
  Desligada por padrão. A escolha fica no cofre do celular (`expo-secure-store`, chaves
  `wrw.trava` e `wrw.trava.aviso`); a biometria fica com o sistema
  (`expo-local-authentication`), e a WRW não recebe nada. Ligar e desligar pedem o Face ID
  ou a digital antes (`mudarATrava`), para quem pega o celular com o app aberto não
  desligar a trava. Depois do login, um aviso nativo oferece ligar; o Perfil do site (`client/src/components/TravaDoApp.tsx`) liga e desliga
  pela ponte da WebView: o site manda `{tipo: "wrw:trava", acao}` por
  `window.ReactNativeWebView.postMessage`, e o app responde com o evento `wrw:trava`
  (`scriptDoEstado`). Só aceita mensagem de página da WRW. As regras puras de `regras/trava.ts`
  são testadas em `server/trava-do-app.test.ts`, porque esta pasta não tem suíte. No Expo
  Go a digital do Android funciona; o Face ID do iPhone só num development build.
- Nenhuma credencial vai no repositório: as chaves das lojas ficam no EAS (`eas credentials`).
  O `.gitignore` desta pasta já recusa `*.p8`, `*.p12`, `*.jks` e `*.key`.
