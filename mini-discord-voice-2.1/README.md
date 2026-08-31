# Guru 3.1

Sala privada de voz com WebRTC, perfis, compartilhamento de tela e TURN.

## Deploy

### Render
- Root Directory: `mini-discord-voice-2.1`
- Build Command: `npm install`
- Start Command: `npm start`
- Variáveis: `TURN_USERNAME`, `TURN_CREDENTIAL`, `TURN_URLS`, `CLIENT_ORIGIN`

### Netlify
- Base Directory: `mini-discord-voice-2.1`
- Build Command: `npm run build:netlify`
- Publish Directory: `public`
- Variável: `SOCKET_SERVER_URL=https://seu-servico.onrender.com`

## 3.1
- Rebrand para Guru.
- Interface dark/preto e branco com blur.
- Layout de apresentação limitado ao viewport e responsivo.
- Controles sempre visíveis durante compartilhamento.
- Estado de microfone mutado sincronizado entre participantes.
- Indicadores de mute no card e painel de participantes.
- Layouts específicos para desktop, tablet e mobile.
