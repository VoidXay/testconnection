# Mini Discord Voice 2.3.1

Sala minimalista de voz + compartilhamento de tela usando WebRTC, Socket.IO e TURN.

## Recursos

- Voz multiusuário em WebRTC mesh.
- TURN Metered para redes com NAT/CGNAT restritivo.
- ICE restart automático em falhas de conexão.
- Compartilhamento de tela em até 1080p / 30 FPS.
- Apenas uma pessoa compartilhando a tela por vez.
- Fullscreen para a tela compartilhada.
- Indicador visual de quem está compartilhando.
- Bolinha verde individual de quem está falando.
- Mute local.
- Noise suppression, echo cancellation e automatic gain control.
- Frontend estático para Netlify.
- Backend Node/Socket.IO para Render.
- Salas por URL `/id-da-sala`.

## Estrutura

O projeto já está na raiz, sem pasta duplicada:

```text
.
├─ package.json
├─ server.js
├─ render.yaml
├─ netlify.toml
├─ scripts/
│  └─ build-netlify.js
└─ public/
   ├─ index.html
   ├─ style.css
   ├─ app.js
   ├─ runtime-config.js
   └─ _redirects
```

## Atualizar seu repositório existente

Abra a pasta raiz do repositório clonado e copie o conteúdo deste pacote por cima dela.

Depois:

```bash
git status
git add .
git commit -m "Add screen sharing"
git push origin main
```

Não copie a pasta do projeto para dentro de outra pasta do projeto. Copie `public`, `scripts`, `server.js`, `package.json`, etc. diretamente para a raiz que contém `.git`.

## Render

Use o mesmo Web Service que já está funcionando.

Configuração:

```text
Build Command: npm install
Start Command: npm start
Health Check: /health
```

Variáveis:

```text
CLIENT_ORIGIN=*
TURN_USERNAME=<username da credencial Metered>
TURN_CREDENTIAL=<password da credencial Metered>
TURN_URLS=turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp
```

Se o Render estiver configurado com `Root Directory=mini-discord-voice-2.1` por causa do repositório atual, mantenha isso enquanto essa pasta continuar sendo a raiz do app dentro do GitHub.

Teste:

```text
https://SEU-SERVICO.onrender.com/health
```

O retorno deve incluir:

```json
{
  "ok": true,
  "version": "2.3.1",
  "turnConfigured": true
}
```

## Netlify

A configuração continua:

```text
Build command: npm run build:netlify
Publish directory: public
```

Variável:

```text
SOCKET_SERVER_URL=https://SEU-SERVICO.onrender.com
```

Se o Netlify atual usa `Base directory=mini-discord-voice-2.1`, mantenha igual para não quebrar o repositório existente.

## Compartilhamento de tela

O botão `Compartilhar tela` usa `navigator.mediaDevices.getDisplayMedia()`.

Configuração de captura:

```text
Resolução ideal: 1920x1080
FPS máximo: 30
Bitrate alvo: 2.5 Mbps por peer
Áudio da tela: desativado
```

O vídeo usa a mesma conexão WebRTC da voz. Cada peer já negocia um transceiver de vídeo desde o início, então iniciar/parar o compartilhamento usa `RTCRtpSender.replaceTrack()` e não cria conexões extras.

O servidor mantém um lock por sala para impedir dois compartilhamentos simultâneos.

## Escala

A arquitetura continua WebRTC mesh. Para poucos amigos funciona bem. Compartilhamento de tela aumenta bastante o upload do compartilhador porque ele envia uma cópia do vídeo para cada participante.

Para salas maiores, a arquitetura indicada é um SFU como LiveKit ou mediasoup.
