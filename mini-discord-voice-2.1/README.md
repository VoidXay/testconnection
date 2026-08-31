# Mini Meet 3.0

Sala privada inspirada em apps de reunião, com voz WebRTC, perfis personalizados e compartilhamento de tela.

## Novidades da 3.0

- Lobby antes da chamada.
- Nick personalizado por participante.
- Foto de perfil opcional, redimensionada no navegador para 256x256.
- Perfil salvo localmente no navegador.
- Edição de nick/foto durante a chamada.
- Participantes reais sincronizados via Socket.IO.
- Indicador verde de fala por participante.
- Painel lateral de participantes.
- Layout inspirado em apps como Google Meet, sem pessoas falsas.
- Compartilhamento de tela mantido.
- TURN/STUN e ICE recovery mantidos.
- Redução de ruído, echo cancellation e auto gain mantidos.

## Estrutura

```text
public/
  index.html
  style.css
  app.js
  runtime-config.js
  _redirects
scripts/
  build-netlify.js
server.js
package.json
netlify.toml
render.yaml
```

O ZIP é entregue diretamente nessa estrutura, sem uma pasta de projeto extra dentro dele.

## Render

Use a mesma configuração já existente:

```text
Root Directory: mini-discord-voice-2.1
Build Command: npm install
Start Command: npm start
```

Variáveis:

```text
CLIENT_ORIGIN=*
TURN_USERNAME=<seu usuário TURN>
TURN_CREDENTIAL=<sua credencial TURN>
TURN_URLS=turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp
```

Teste:

```text
https://SEU-SERVICO.onrender.com/health
```

Deve retornar `version: "3.0.0"` e `turnConfigured: true`.

## Netlify

```text
Base directory: mini-discord-voice-2.1
Build command: npm run build:netlify
Publish directory: public
```

Variável:

```text
SOCKET_SERVER_URL=https://SEU-SERVICO.onrender.com
```

## Atualização no seu repositório

Copie **o conteúdo deste pacote** para:

```text
testconnection-repo-clean/mini-discord-voice-2.1
```

Substitua os arquivos existentes e, na raiz `testconnection-repo-clean`, rode:

```bash
git status
git add .
git commit -m "Redesign meeting UI and add participant profiles"
git push origin main
```
