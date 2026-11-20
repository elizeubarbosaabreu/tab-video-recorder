# Tab Video Recorder

Extensão MV3 para Brave/Chrome que grava o vídeo e o áudio interno de uma aba, recorta a imagem no
elemento `<video>`, usa a resolução real do vídeo como tamanho de saída e encerra a gravação sozinha
quando o vídeo termina.

## Instalação (unpacked)

1. Abra `brave://extensions` (ou `chrome://extensions`).
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione esta pasta.
4. Fixe o ícone na barra para facilitar o acesso.

## Uso

1. Abra a página com o vídeo e deixe-o em reprodução (ou pausado, se preferir começar do ponto atual).
2. Clique no ícone da extensão. O popup mostra a resolução e a duração detectadas.
3. Ajuste se quiser:
   - **Gravar a aba inteira**: ignora o recorte no vídeo e grava toda a área visível.
   - **Resolução máxima**: 720p, 1080p ou Nativa.
   - **Ouvir durante a gravação**: reencaminha o áudio capturado para as caixas de som.
4. Clique em **Gravar esta aba** e escolha onde salvar o `.webm` (a gravação é escrita direto
   nesse arquivo, sem limite de tamanho).
5. A gravação para sozinha no fim do vídeo e o arquivo fica fechado, pronto para uso.
6. Para encerrar antes, abra o popup e clique em **Parar e salvar**.

## Gravação direta no disco

- O popup abre o seletor de arquivo (`showSaveFilePicker`) e guarda o `FileSystemFileHandle` no
  IndexedDB; o documento offscreen lê o handle e escreve cada chunk do `MediaRecorder` direto no
  arquivo escolhido (`createWritable()`), sem acumular na memória.
- Ao final (fim do vídeo, parada manual, aba fechada ou erro), a fila de escrita é esvaziada e o
  arquivo é fechado — não há download intermediário nem blob de vários GB.
- Se a API não estiver disponível ou a permissão de escrita falhar, a extensão avisa no popup e cai
  no modo memória, que mantém o teto de 1,5 GB.

## Como funciona

| Peça | Papel |
| --- | --- |
| `js/popup.js` | detecta a aba ativa, injeta o detector, inicia a captura e mostra o status |
| `js/detector.js` | escolhe o vídeo principal, mede o retângulo visível e avisa quando ele termina |
| `js/background.js` | orquestra o fluxo, mantém o estado, o badge e o download |
| `js/offscreen.js` | captura a aba, recorta em canvas, grava com `MediaRecorder` e finaliza o arquivo |
| `js/fs-handle-store.js` | guarda no IndexedDB o `FileSystemFileHandle` escolhido no popup |

- A captura usa `chrome.tabCapture` + documento offscreen, o padrão do Manifest V3.
- O detector escuta `ended` e `pause` no fim, além de `timeupdate` quando
  `currentTime >= duration - 0.3 s`, e encerra a gravação sozinho.
- O canvas tem tamanho fixo durante toda a gravação; mudanças de layout não alteram a resolução do arquivo.
- O loop de desenho usa `MediaStreamTrackProcessor` porque `requestAnimationFrame` não roda em
  documentos offscreen.
- O estado fica em `chrome.storage.session`; o offscreen é o dono da gravação, então a suspensão do
  service worker não interrompe a captura.

## Limitações conhecidas

- Escolher o arquivo no popup abre o diálogo do sistema; se o popup fechar durante o diálogo, a
  gravação não inicia (basta clicar de novo).
- No modo memória (fallback), a gravação para em ~1,5 GB porque os chunks ficam na RAM.
- **DRM não é gravável.** Netflix, Disney+, Prime Video e similares entregam frames protegidos; a
  imagem gravada fica preta. O popup avisa quando detecta `video.mediaKeys`.
- A qualidade é limitada ao que a aba renderiza. Para máxima nitidez, coloque o player em tela cheia.
- A gravação salva o que está sendo reproduzido; não baixa o arquivo original do site.
- Anúncios no meio do vídeo entram na gravação.
- Vídeos em iframes de outra origem não são detectados; nesse caso use **Gravar a aba inteira**.
- Aba em segundo plano pode reduzir fps e qualidade. Mantenha a aba visível quando possível.
- Páginas `chrome://`, `brave://`, Chrome Web Store e o visualizador de PDF não podem ser gravadas.
- Saída em WebM (VP9/VP8 + Opus). Para MP4, converta depois com ffmpeg:
  `ffmpeg -i gravacao.webm -c:v libx264 -c:a aac gravacao.mp4`.

## Se o áudio não sair

- Com **Ouvir durante a gravação** desligado, a aba fica muda durante a captura (comportamento do
  `tabCapture`); o áudio continua indo para o arquivo.
- Se a aba estiver mutada no player, a gravação também fica muda.
- Verifique se outra extensão ou programa não está capturando a mesma aba.

## Estrutura

```
manifest.json
popup.html
css/popup.css
js/popup.js
js/detector.js
js/background.js
js/offscreen.js
js/fs-handle-store.js
offscreen.html
icons/*.png
```

## Permissões

- `activeTab`: acessar a aba apenas quando você clica na extensão.
- `scripting`: injetar o detector na aba.
- `tabCapture` + `offscreen`: capturar vídeo e áudio da aba.
- `downloads`: salvar o arquivo em `Downloads/TabRecorder`.
- `storage`: guardar preferências e o estado da gravação.
