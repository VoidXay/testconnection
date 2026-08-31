# Mini Discord Voice 2.1

Sala de voz minimalista com WebRTC + Socket.IO.

## O que já está pronto

- Frontend estático compatível com Netlify.
- Backend Node/Socket.IO compatível com Render.
- Render também consegue servir o frontend para teste.
- Salas por URL: `/id-da-sala`.
- Áudio multiusuário em WebRTC mesh.
- Indicador verde individual de quem está falando.
- Mute local.
- Redução de ruído do navegador com toggle.
- Echo cancellation e automatic gain control.
- Reconexão Socket.IO.
- Rewrite do Netlify para links de sala.
- Endpoint `/health` para o Render.

## Estrutura

```text
mini-discord-voice/
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

## Testar localmente

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

O site cria automaticamente uma sala, por exemplo:

```text
http://localhost:3000/14f82d6a1c41437fab
```

## 1. Publicar backend no Render

Suba esta pasta inteira para um repositório no GitHub.

No Render:

1. `New` -> `Web Service`.
2. Conecte o repositório.
3. Runtime: `Node`.
4. Build Command: `npm install`.
5. Start Command: `npm start`.
6. Publique.

O `render.yaml` já contém a mesma configuração caso você prefira usar Blueprint.

Depois do deploy você receberá uma URL parecida com:

```text
https://mini-discord-voice.onrender.com
```

Teste:

```text
https://mini-discord-voice.onrender.com/health
```

Deve responder com `ok: true`.

## 2. Publicar frontend no Netlify

Use o mesmo repositório no Netlify.

A configuração já está em `netlify.toml`:

```text
Build command: npm run build:netlify
Publish directory: public
```

Antes do deploy, adicione esta variável de ambiente no Netlify:

```text
SOCKET_SERVER_URL=https://SEU-SERVICO.onrender.com
```

Use exatamente a URL HTTPS fornecida pelo Render, sem barra no final.

Depois publique o site.

## 3. Opcional: restringir o backend ao seu Netlify

Quando souber o domínio final do Netlify, no Render troque:

```text
CLIENT_ORIGIN=*
```

por:

```text
CLIENT_ORIGIN=https://seu-site.netlify.app
```

Para permitir mais de um domínio, separe por vírgula:

```text
CLIENT_ORIGIN=https://site.netlify.app,https://seudominio.com
```

## Ruído

A captura solicita:

```js
echoCancellation: true
noiseSuppression: true
autoGainControl: true
channelCount: 1
```

O botão `Ruído` usa `MediaStreamTrack.applyConstraints()` para ligar/desligar `noiseSuppression` enquanto a chamada está ativa.

Esse recurso depende do navegador e do dispositivo. Chrome/Edge modernos normalmente expõem esse controle.

## Indicador de fala

Cada stream é analisado localmente com Web Audio API. Quando o RMS do áudio passa do limiar, a bolinha do participante fica verde por alguns milissegundos para evitar flicker.

Nenhum áudio é enviado para o Render. O Render é usado somente para sinalização Socket.IO/WebRTC.

## TURN

Esta versão usa STUN público do Google, suficiente para testes em muitas redes.

Algumas combinações de NAT/firewall podem impedir a conexão P2P. Nesse caso, adicione um servidor TURN em `rtcConfiguration` dentro de `public/app.js`.

## Observação sobre escala

A chamada usa WebRTC mesh. Para brincar com poucos amigos funciona bem. Para salas grandes, migre a mídia para um SFU como LiveKit ou mediasoup.
