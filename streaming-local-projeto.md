# Streaming Local para Rede Interna — Documento de Projeto

## 1. Visão geral

Um app tipo "mini Jellyfin/Plex" pessoal:
- **Backend (Node.js)**: lê um diretório configurável no disco, extrai metadados dos vídeos, serve os arquivos pela rede local, e faz transcode/remux quando necessário.
- **Frontend (Next.js)**: lista os arquivos encontrados e reproduz o vídeo selecionado num player web.
- **Config**: tela para o usuário apontar o diretório onde estão os vídeos.

Escopo do protótipo: só vídeo (mp4, mkv, avi, mov, webm...), sem usuários/autenticação, uso na rede local (Wi-Fi de casa).

---

## 2. O problema técnico central: MKV não toca direto no navegador

Isso é o ponto mais importante do projeto e define a arquitetura do backend.

- **MP4 (H.264 + AAC)** funciona direto na tag `<video>` em qualquer navegador, sem processamento — só servir os bytes com suporte a `Range` requests.
- **MKV é só um container** (Matroska). Mesmo que o vídeo dentro seja H.264/AAC (o mesmo codec que o navegador já sabe tocar), **nenhum navegador (Chrome, Firefox, Safari, Edge) entende o container MKV**. Ele simplesmente ignora ou baixa o arquivo em vez de tocar. Esse é um problema conhecido até em players maduros como o Jellyfin, que às vezes tenta "DirectPlay" um MKV no Chrome e falha silenciosamente.
- MKV também costuma carregar coisas ainda mais problemáticas: áudio AC3/DTS, vídeo HEVC, várias faixas de áudio/legenda — nada disso o navegador entende nativamente.

**Conclusão prática**: seu backend precisa, no mínimo, fazer **remux** (trocar o container MKV→MP4 sem recodificar, quando o codec já é compatível) ou **transcode completo** (recodificar quando o codec não é compatível, ex: HEVC/AC3). Isso é exatamente o que Plex/Jellyfin fazem por baixo dos panos com FFmpeg.

---

## 3. Arquitetura proposta

```
[Diretório local de vídeos]
        │
        ▼
 ┌─────────────────────────────┐
 │   Backend Node.js           │
 │  - Scanner (fs + ffprobe)   │
 │  - API REST (Express/Fastify)│
 │  - Streaming c/ Range        │
 │  - FFmpeg (remux/transcode)  │
 └─────────────────────────────┘
        │  HTTP (rede local)
        ▼
 ┌─────────────────────────────┐
 │  Frontend Next.js            │
 │  - Lista de arquivos         │
 │  - Player (<video> + hls.js) │
 │  - Tela de Config            │
 └─────────────────────────────┘
```

Frontend e backend rodam como processos separados na mesma máquina (ou máquinas diferentes na rede), o Next.js consome a API do Node via `fetch` apontando pro IP local do servidor.

---

## 4. Backend (Node.js)

### 4.1 Scanner de arquivos
- Ler o diretório configurado recursivamente (`fs.readdir` com `withFileTypes`, ou lib como `fast-glob`).
- Filtrar por extensão: `.mp4, .mkv, .avi, .mov, .webm, .m4v`.
- Para cada arquivo, rodar **ffprobe** (via `fluent-ffmpeg` ou `execa` chamando o binário) pra extrair: duração, codec de vídeo/áudio, resolução, container, faixas de legenda/áudio.
- Guardar isso num índice simples (pode ser um JSON em disco ou SQLite via `better-sqlite3` — nada de banco pesado pro protótipo).
- Rodar o scan ao iniciar o servidor e expor um endpoint `POST /api/library/rescan` para reindexar manualmente (ou usar `chokidar` pra watch automático do diretório).

### 4.2 Decisão: direct play vs remux vs transcode
Lógica por arquivo, baseada no que o ffprobe retornou:

| Situação | Ação |
|---|---|
| Container MP4 + H.264 + AAC | **Direct play** — só serve o arquivo com Range requests, zero processamento |
| Container MKV + H.264 + AAC | **Remux** — FFmpeg troca só o container pra fragmented MP4, sem recodificar (rápido, baixo CPU) |
| Codec incompatível (HEVC, AC3, DTS, VP9 em contexto errado etc) | **Transcode completo** — FFmpeg recodifica pra H.264/AAC, geralmente em HLS (segmentos .ts + manifest .m3u8) pra permitir streaming progressivo sem esperar o arquivo inteiro processar |

Para o protótipo, o mais simples de implementar primeiro é: **direct play para MP4 compatível**, e **remux/transcode on-the-fly via HLS para o resto**. FFmpeg gera os segmentos conforme o player pede, sem precisar processar o vídeo inteiro antes.

### 4.3 Streaming
- Direct play: endpoint `GET /api/stream/:id` que abre um `ReadStream` do arquivo e responde com `206 Partial Content` respeitando o header `Range` (isso é o que permite pular pra qualquer ponto do vídeo sem baixar tudo antes).
- Transcode/remux: endpoint que spawna um processo FFmpeg e serve a saída como HLS (`GET /api/stream/:id/playlist.m3u8` + segmentos), ou faz pipe direto do stdout do FFmpeg pra resposta HTTP em fragmented MP4.

### 4.4 API sugerida
```
GET  /api/library              -> lista de vídeos (id, nome, duração, thumbnail, container, precisa-de-transcode)
GET  /api/library/:id          -> detalhes de um vídeo
POST /api/library/rescan       -> reindexa o diretório
GET  /api/stream/:id           -> stream direto (MP4 compatível)
GET  /api/stream/:id/hls.m3u8  -> stream via HLS (remux/transcode)
GET  /api/config               -> retorna diretório atual configurado
POST /api/config               -> define novo diretório
```

### 4.5 Libs recomendadas
- `express` ou `fastify` — servidor HTTP
- `fluent-ffmpeg` — wrapper de FFmpeg (precisa ter o binário `ffmpeg`/`ffprobe` instalado no sistema, ou usar `ffmpeg-static`/`ffprobe-static` pra empacotar junto)
- `chokidar` — watch de diretório (opcional, pra reindexar automaticamente)
- `better-sqlite3` — índice simples da biblioteca (opcional pro protótipo; um JSON já resolve)

---

## 5. Frontend (Next.js)

### 5.1 Telas
1. **Lista de arquivos** (home): grid ou lista com thumbnail, nome, duração. Clique abre o player.
2. **Player**: `<video>` nativo pra arquivos direct-play, com `hls.js` (biblioteca JS que faz o HTML5 video tocar streams HLS em navegadores que não suportam nativamente, como Chrome/Firefox) pra arquivos que precisam de remux/transcode. Safari toca HLS nativamente, os outros precisam do hls.js.
3. **Config**: onde o usuário define o diretório da biblioteca.

### 5.2 Detalhe importante sobre o botão "selecionar diretório"
Aqui tem uma pegadinha: como o Next.js roda no navegador do cliente, mas o diretório de vídeos está no **servidor** (a máquina que roda o Node), um `<input type="file" webkitdirectory>` do navegador vai abrir o seletor de arquivos do **computador que está acessando a página**, não do servidor. Isso só funciona se front e back rodarem na mesma máquina que você está navegando.

Duas abordagens:
- **Se front/back sempre rodam na mesma máquina** (ex: um mini-servidor caseiro que você acessa localmente): pode usar um input de texto simples onde o usuário cola o caminho absoluto (ex: `/home/usuario/Videos`), com um botão "Testar" que chama a API pra validar se o caminho existe e lista o conteúdo.
- **Mais robusto (recomendado)**: um "file browser" simples do lado do servidor — endpoint `GET /api/browse?path=/algum/caminho` que retorna as pastas daquele nível, e o frontend mostra isso como um modal de navegação (tipo um explorador de arquivos dentro da tela de Config). O usuário clica nas pastas até achar a certa e confirma. Isso evita erro de digitação e funciona mesmo acessando de outro dispositivo na rede (celular, outro PC).

Vale a pena definir isso antes de começar a codar, porque muda a UI da tela de Config.

### 5.3 Libs recomendadas
- `hls.js` — tocar streams HLS no player
- `swr` ou `@tanstack/react-query` — buscar e cachear a lista de arquivos
- Tailwind — estilização rápida

---

## 6. Roadmap sugerido (MVP incremental)

1. Backend: scanner simples (fs.readdir) + endpoint `/api/library` retornando lista bruta, sem ffprobe ainda.
2. Backend: endpoint de stream direto com suporte a Range, testando só com MP4.
3. Frontend: lista de arquivos + player básico consumindo o backend.
4. Backend: integrar ffprobe pra pegar metadados reais (duração, codec).
5. Backend: lógica de decisão direct-play vs remux, implementar remux MKV→MP4/HLS via FFmpeg.
6. Frontend: integrar hls.js no player pra tocar os streams remuxados/transcodificados.
7. Frontend: tela de Config com o seletor/navegador de diretório.
8. Extras (pós-MVP): geração de thumbnails, suporte a legendas embutidas, watch automático de pasta, transcode adaptativo por qualidade.

---

## 7. Riscos e pontos de atenção
- **CPU do transcode**: transcodificar em tempo real consome CPU real. Se a máquina servidor for fraca, prefira sempre remux (sem recodificar) quando possível, e reserve transcode completo só pra casos realmente incompatíveis.
- **FFmpeg precisa estar instalado** na máquina do servidor (ou empacotado via `ffmpeg-static`).
- **Múltiplos dispositivos assistindo ao mesmo tempo** = múltiplos processos FFmpeg em paralelo — pensar em limite de streams simultâneos se a máquina for modesta.
- **Legendas embutidas em MKV** não aparecem automaticamente — precisa extrair via FFmpeg e servir como trilha WebVTT separada, se quiser suportar isso no futuro.
